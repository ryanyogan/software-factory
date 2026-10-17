import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

/*
 * Git plumbing for the daemon and context resolution (research §5). Plain `git` via execFile, no deps.
 * Worktree admin commands run with cwd = the main repo and are serialized per repo (index.lock).
 */

const pexec = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | undefined,
  ) {
    super(message);
  }
}

export interface GitOptions {
  env?: Record<string, string | undefined>;
  input?: string;
}

export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  try {
    const child = pexec('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env },
    });
    if (opts.input !== undefined) child.child.stdin?.end(opts.input);
    const r = await child;
    return r.stdout.trimEnd();
  } catch (e) {
    const err = e as { stderr?: string; code?: number; message: string };
    const stderr = (err.stderr ?? '').trim();
    throw new GitError(
      `git ${args.join(' ')}: ${stderr || err.message}`,
      stderr,
      typeof err.code === 'number' ? err.code : undefined,
    );
  }
}

/** True when `git <args>` exits 0. */
async function ok(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Root of the MAIN checkout for any path inside a repo or one of its worktrees
 * (the parent of the common `.git` dir). Null when `cwd` is not in a git repo.
 */
export async function mainRepoRoot(cwd: string): Promise<string | null> {
  try {
    const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return dirname(common);
  } catch {
    return null;
  }
}

/** Current branch name, or null when detached / not a repo. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const b = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return b || null;
  } catch {
    return null;
  }
}

export async function remoteUrl(cwd: string, remote = 'origin'): Promise<string | null> {
  try {
    return (await git(cwd, ['remote', 'get-url', remote])) || null;
  } catch {
    return null;
  }
}

/**
 * Canonical `host/owner/repo` for comparing remotes and `project.repoUrl`:
 * `git@github.com:a/b.git`, `ssh://git@github.com/a/b`, `https://github.com/a/b.git/` → `github.com/a/b`.
 */
export function normalizeRepoUrl(url: string): string {
  let s = url.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const u = new URL(s);
      s = `${u.hostname}${u.pathname}`;
    } catch {
      // keep as-is (local path etc.)
    }
  }
  return s
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
}

export function isGitHubUrl(url: string | null): boolean {
  return url !== null && normalizeRepoUrl(url).startsWith('github.com/');
}

/** Branch a task worktree starts from: origin/HEAD, else the main checkout's branch, else main/master. */
export async function defaultBranch(repo: string): Promise<string> {
  try {
    const ref = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (ref) return ref.replace(/^origin\//, '');
  } catch {
    // no remote HEAD
  }
  for (const b of ['main', 'master']) {
    if (await ok(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  }
  const head = await currentBranch(repo);
  if (head) return head;
  throw new GitError(`cannot determine the default branch of ${repo}`, '', undefined);
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length) };
      entries.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch '))
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return entries;
}

/* -------------------------------------------------------------------------------------------- */

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier `withRepoLock(repo, …)` call has settled. */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(repo) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    repo,
    next.catch(() => undefined),
  );
  return next;
}

export interface EnsuredWorktree {
  path: string;
  branch: string;
  /** Branch the worktree was based on. */
  baseBranch: string;
  /** merge-base(baseBranch, HEAD): what diffs are taken against. */
  baseSha: string;
  created: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure `path` is a worktree of `repo` with `branch` checked out: reuse it if listed, else create
 * it (new branch from the default branch, or check out the existing branch).
 */
export function ensureWorktree(opts: {
  repo: string;
  path: string;
  branch: string;
}): Promise<EnsuredWorktree> {
  const repo = resolve(opts.repo);
  const path = resolve(opts.path);
  return withRepoLock(repo, async () => {
    const baseBranch = await defaultBranch(repo);
    let created = false;
    const listed = (await listWorktrees(repo)).find((w) => resolve(w.path) === path);
    if (!listed) {
      await git(repo, ['worktree', 'prune']);
      if (await exists(path)) {
        throw new GitError(
          `${path} exists but is not a worktree of ${repo}; move it away and retry`,
          '',
          undefined,
        );
      }
      await mkdir(dirname(path), { recursive: true });
      const branchExists = await ok(repo, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${opts.branch}`,
      ]);
      await git(
        repo,
        branchExists
          ? ['worktree', 'add', path, opts.branch]
          : ['worktree', 'add', '-b', opts.branch, path, baseBranch],
      );
      created = true;
    } else if (listed.branch !== opts.branch) {
      // Someone switched branches in the task worktree: put it back on the task branch.
      await git(path, ['checkout', opts.branch]);
    }
    const baseSha = await git(path, ['merge-base', baseBranch, 'HEAD']);
    return { path, branch: opts.branch, baseBranch, baseSha, created };
  });
}

export function removeWorktree(repo: string, path: string): Promise<void> {
  return withRepoLock(resolve(repo), async () => {
    await git(repo, ['worktree', 'remove', '--force', path]).catch(() => undefined);
    await git(repo, ['worktree', 'prune']);
  });
}

/* -------------------------------------------------------------------------------------------- */

export interface WorktreeDiff {
  patch: string;
  stats: { files: number; additions: number; deletions: number };
  truncated: boolean;
}

/**
 * Diff of the worktree (committed + staged + unstaged + untracked, honouring .gitignore) against
 * `base`, via a temporary index so the worktree's real index is untouched.
 */
export async function diffAgainst(
  cwd: string,
  base: string,
  maxChars: number,
): Promise<WorktreeDiff> {
  const dir = await mkdtemp(join(tmpdir(), 'sf-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await git(cwd, ['read-tree', 'HEAD'], { env });
    await git(cwd, ['add', '-A'], { env });
    const common = [
      'diff',
      '--cached',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
    ];
    const numstat = await git(cwd, [...common, '--numstat'], { env });
    const stats = { files: 0, additions: 0, deletions: 0 };
    for (const line of numstat.split('\n')) {
      if (!line) continue;
      const [a, d] = line.split('\t');
      stats.files++;
      stats.additions += Number(a) || 0; // '-' for binary
      stats.deletions += Number(d) || 0;
    }
    const patch = stats.files ? await git(cwd, common, { env }) : '';
    return patch.length > maxChars
      ? { patch: '', stats, truncated: true }
      : { patch: patch ? `${patch}\n` : '', stats, truncated: false };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `git add -A && git commit` when anything changed. Returns the new sha, or null if clean. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  const status = await git(cwd, ['status', '--porcelain']);
  if (!status) return null;
  await git(cwd, ['add', '-A']);
  // Use the user's identity; only fall back when git has none configured.
  const hasIdentity = await ok(cwd, ['config', 'user.email']);
  const identity = hasIdentity ? [] : ['-c', 'user.name=sf', '-c', 'user.email=sf@localhost'];
  await git(cwd, [...identity, 'commit', '--no-verify', '-q', '-F', '-'], { input: message });
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** Commits on HEAD that are not on `base` (0 = nothing to push / PR). */
export async function aheadCount(cwd: string, base: string): Promise<number> {
  return Number(await git(cwd, ['rev-list', '--count', `${base}..HEAD`])) || 0;
}
