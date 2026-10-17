import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { git, isGitHubUrl, normalizeRepoUrl, remoteUrl } from './git';

/*
 * Opening the draft PR at run end. `gh` is the default; `fake` records PRs in memory without
 * pushing (tests, `pnpm gate:local`); `none` never opens one.
 * Selection: env SF_PR_PROVIDER > config `daemon.prProvider` > `gh`.
 */

export interface OpenPrInput {
  /** The task worktree (branch checked out, commits made). */
  cwd: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface PrProvider {
  readonly name: string;
  /** Opens (or finds) the PR for `branch`; null when not applicable (e.g. no GitHub remote). */
  open(input: OpenPrInput): Promise<{ url: string } | null>;
}

const pexec = promisify(execFile);

async function gh(cwd: string, args: string[], input?: string): Promise<string> {
  const child = pexec('gh', args, {
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (input !== undefined) child.child.stdin?.end(input);
  return (await child).stdout.trim();
}

/** Real provider: `git push -u origin <branch>` then `gh pr create --draft` (research §6). */
export const ghPrProvider: PrProvider = {
  name: 'gh',
  async open({ cwd, branch, base, title, body }) {
    if (!isGitHubUrl(await remoteUrl(cwd))) return null;
    await git(cwd, ['push', '-u', 'origin', branch]);
    try {
      const existing = await gh(cwd, ['pr', 'view', branch, '--json', 'url', '-q', '.url']);
      if (existing) return { url: existing };
    } catch {
      // no PR yet
    }
    const out = await gh(
      cwd,
      [
        'pr',
        'create',
        '--draft',
        '--head',
        branch,
        '--base',
        base,
        '--title',
        title,
        '--body-file',
        '-',
      ],
      body,
    );
    const url = out.split('\n').filter(Boolean).at(-1);
    if (!url?.startsWith('http')) throw new Error(`gh pr create printed no URL: ${out}`);
    return { url };
  },
};

export interface FakePrProvider extends PrProvider {
  readonly opened: (OpenPrInput & { url: string })[];
}

/** Never pushes. URL: the GitHub remote's repo if there is one, else `github.com/sf-fake/<dir>`. */
export function createFakePrProvider(): FakePrProvider {
  const opened: FakePrProvider['opened'] = [];
  return {
    name: 'fake',
    opened,
    async open(input) {
      const existing = opened.find((p) => p.cwd === input.cwd && p.branch === input.branch);
      if (existing) return { url: existing.url };
      const remote = await remoteUrl(input.cwd);
      const repo = isGitHubUrl(remote)
        ? normalizeRepoUrl(remote!).replace(/^github\.com\//, '')
        : `sf-fake/${encodeURIComponent(basename(input.cwd))}`;
      const url = `https://github.com/${repo}/pull/${opened.length + 1}`;
      opened.push({ ...input, url });
      return { url };
    },
  };
}

export const nonePrProvider: PrProvider = { name: 'none', open: async () => null };

export function selectPrProvider(name: string | undefined): PrProvider {
  switch (name ?? 'gh') {
    case 'gh':
      return ghPrProvider;
    case 'fake':
      return createFakePrProvider();
    case 'none':
      return nonePrProvider;
    default:
      throw new Error(`unknown PR provider "${name}" (gh | fake | none)`);
  }
}
