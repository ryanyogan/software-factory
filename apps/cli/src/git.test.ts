import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  aheadCount,
  commitAll,
  currentBranch,
  defaultBranch,
  diffAgainst,
  ensureWorktree,
  git,
  isGitHubUrl,
  listWorktrees,
  mainRepoRoot,
  normalizeRepoUrl,
  withRepoLock,
} from './git';
import { createFakePrProvider } from './pr';
import { makeRepo, tempDir } from './test-repo';

describe('normalizeRepoUrl', () => {
  it('treats ssh, scp and https forms of one repo as equal', () => {
    for (const u of [
      'git@github.com:Acme/Web.git',
      'ssh://git@github.com/acme/web',
      'https://github.com/acme/web.git/',
      'https://github.com/acme/web',
    ]) {
      expect(normalizeRepoUrl(u)).toBe('github.com/acme/web');
    }
    expect(isGitHubUrl('git@github.com:a/b.git')).toBe(true);
    expect(isGitHubUrl('https://gitlab.com/a/b')).toBe(false);
    expect(isGitHubUrl(null)).toBe(false);
  });
});

describe('worktree manager', () => {
  it('creates the task worktree from the default branch, then reuses it', async () => {
    const repo = await makeRepo();
    const path = join(await tempDir('sf-wt-'), 'prj_1', 'tsk_1');
    expect(await defaultBranch(repo)).toBe('main');

    const first = await ensureWorktree({ repo, path, branch: 'sf/add-login' });
    expect(first).toMatchObject({ created: true, branch: 'sf/add-login', baseBranch: 'main' });
    expect(first.baseSha).toBe(await git(repo, ['rev-parse', 'main']));
    expect(await currentBranch(path)).toBe('sf/add-login');
    // From inside the worktree, the main checkout is still found (context resolution).
    expect(await mainRepoRoot(path)).toBe(await realpath(repo));
    expect((await listWorktrees(repo)).map((w) => w.branch)).toContain('sf/add-login');

    const again = await ensureWorktree({ repo, path, branch: 'sf/add-login' });
    expect(again.created).toBe(false);
    expect(again.baseSha).toBe(first.baseSha);
  });

  it('checks out an existing branch instead of creating it', async () => {
    const repo = await makeRepo();
    await git(repo, ['branch', 'sf/existing']);
    const path = join(await tempDir('sf-wt-'), 'tsk');
    const wt = await ensureWorktree({ repo, path, branch: 'sf/existing' });
    expect(wt.created).toBe(true);
    expect(await currentBranch(path)).toBe('sf/existing');
  });

  it('refuses a non-worktree directory in the way', async () => {
    const repo = await makeRepo();
    const path = join(await tempDir('sf-wt-'), 'tsk');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'x'), 'x');
    await expect(ensureWorktree({ repo, path, branch: 'sf/x' })).rejects.toThrow(/not a worktree/);
  });

  it('diffs against the base incl. untracked files without touching the index', async () => {
    const repo = await makeRepo();
    const path = join(await tempDir('sf-wt-'), 'tsk');
    const wt = await ensureWorktree({ repo, path, branch: 'sf/diff' });
    await writeFile(join(path, 'README.md'), '# test\nmore\n');
    await writeFile(join(path, 'new.txt'), 'hello\n');
    await writeFile(join(path, 'ignored.txt'), 'nope\n');

    const d = await diffAgainst(path, wt.baseSha, 1024 * 1024);
    expect(d.stats).toEqual({ files: 2, additions: 2, deletions: 0 });
    expect(d.patch).toContain('+++ b/new.txt');
    expect(d.patch).toContain('+more');
    expect(d.patch).not.toContain('ignored.txt');
    expect(d.truncated).toBe(false);
    // The real index is untouched: new.txt is still untracked.
    expect(await git(path, ['status', '--porcelain'])).toContain('?? new.txt');

    const small = await diffAgainst(path, wt.baseSha, 10);
    expect(small).toMatchObject({ patch: '', truncated: true, stats: { files: 2 } });

    // Committed changes still show up against the base.
    const sha = await commitAll(path, 'Task title\n\nsf run run_1\n');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitAll(path, 'nothing')).toBeNull();
    expect(await aheadCount(path, wt.baseSha)).toBe(1);
    expect(await git(path, ['log', '-1', '--format=%s'])).toBe('Task title');
    expect((await diffAgainst(path, wt.baseSha, 1e6)).stats.files).toBe(2);
  });

  it('serializes work per repo', async () => {
    const order: number[] = [];
    await Promise.all([
      withRepoLock('/r', async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      }),
      withRepoLock('/r', async () => order.push(2)),
    ]);
    expect(order).toEqual([1, 2]);
  });
});

describe('fake PR provider', () => {
  it('never pushes and returns one stable URL per branch', async () => {
    const repo = await makeRepo({ remote: 'git@github.com:acme/web.git' });
    const pr = createFakePrProvider();
    const input = { cwd: repo, branch: 'sf/x', base: 'main', title: 't', body: 'b' };
    expect(await pr.open(input)).toEqual({ url: 'https://github.com/acme/web/pull/1' });
    expect(await pr.open(input)).toEqual({ url: 'https://github.com/acme/web/pull/1' });
    expect(pr.opened).toHaveLength(1);
    expect(await readFile(join(repo, '.git', 'config'), 'utf8')).not.toContain('[branch "sf/x"]');
  });
});
