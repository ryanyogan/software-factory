// Test helper: a throwaway git repo with one commit on `main`.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './git';

export async function tempDir(prefix = 'sf-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function makeRepo(opts: { remote?: string } = {}): Promise<string> {
  const repo = await tempDir('sf-repo-');
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repo, 'README.md'), '# test\n');
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  if (opts.remote) await git(repo, ['remote', 'add', 'origin', opts.remote]);
  return repo;
}
