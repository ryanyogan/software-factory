import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import type { SfConfig } from './config';
import { chooseProject, findLink, resolveRunTarget } from './context';
import { ensureWorktree, git } from './git';
import { makeRepo, tempDir } from './test-repo';

const NOW = '2026-10-17T11:15:54.123Z';
const project = (id: string, repoUrl: string | null) => ({ id, name: id, repoUrl, createdAt: NOW });
const task = (id: string, branch: string) => ({
  id,
  projectId: 'prj_1',
  title: id,
  branch,
  status: 'open' as const,
  createdAt: NOW,
});

function stubClient(tasks: ReturnType<typeof task>[]) {
  const calls: [string, unknown][] = [];
  const client: Client = {
    async call(name, input) {
      calls.push([name, input]);
      if (name === 'task.list') return { tasks } as never;
      if (name === 'task.create') return task('tsk_new', 'sf/new') as never;
      throw new Error(`unexpected ${name}`);
    },
  };
  return { client, calls };
}

async function linkedRepo() {
  const repo = await realpath(await makeRepo({ remote: 'git@github.com:acme/web.git' }));
  const config: SfConfig = { links: { [repo]: { projectId: 'prj_1', linkedAt: NOW } } };
  return { repo, config };
}

describe('sf link: chooseProject', () => {
  it('matches the origin remote against project repoUrl', async () => {
    const repo = await makeRepo({ remote: 'git@github.com:acme/web.git' });
    const projects = [project('prj_1', 'https://github.com/acme/web'), project('prj_2', null)];
    expect((await chooseProject({ repoRoot: repo, projects })).id).toBe('prj_1');
    expect((await chooseProject({ repoRoot: repo, projectId: 'prj_2', projects })).id).toBe(
      'prj_2',
    );
    await expect(chooseProject({ repoRoot: repo, projectId: 'prj_x', projects })).rejects.toThrow(
      /not found/,
    );
  });

  it('errors clearly on no match, several matches, or no remote', async () => {
    const repo = await makeRepo({ remote: 'https://github.com/acme/web.git' });
    await expect(
      chooseProject({ repoRoot: repo, projects: [project('p', 'https://github.com/x/y')] }),
    ).rejects.toThrow(/no project has repo .*--project ID or create one/);
    const dup = [
      project('a', 'https://github.com/acme/web'),
      project('b', 'git@github.com:acme/web'),
    ];
    await expect(chooseProject({ repoRoot: repo, projects: dup })).rejects.toThrow(
      /several projects .*a, b/,
    );
    const bare = await makeRepo();
    await expect(chooseProject({ repoRoot: bare, projects: dup })).rejects.toThrow(/no `origin`/);
  });
});

describe('sf run start: context resolution', () => {
  it('uses --task as given', async () => {
    const { client, calls } = stubClient([]);
    const t = await resolveRunTarget({ cwd: '/', config: {}, client, task: 'tsk_9' });
    expect(t).toEqual({ taskId: 'tsk_9' });
    expect(calls).toEqual([]);
  });

  it('finds the task of the current branch, also from inside the task worktree', async () => {
    const { repo, config } = await linkedRepo();
    const { client } = stubClient([task('tsk_1', 'sf/add-login'), task('tsk_2', 'main')]);
    expect(await findLink(repo, config)).toEqual({ repoRoot: repo, projectId: 'prj_1' });
    expect((await resolveRunTarget({ cwd: repo, config, client })).taskId).toBe('tsk_2');

    const wt = join(await tempDir('sf-wt-'), 'tsk_1');
    await ensureWorktree({ repo, path: wt, branch: 'sf/add-login' });
    expect((await resolveRunTarget({ cwd: wt, config, client })).taskId).toBe('tsk_1');
  });

  it('creates a task with --title in the linked project', async () => {
    const { repo, config } = await linkedRepo();
    const { client, calls } = stubClient([]);
    const t = await resolveRunTarget({ cwd: repo, config, client, title: 'New thing' });
    expect(t.taskId).toBe('tsk_new');
    expect(calls).toEqual([['task.create', { projectId: 'prj_1', title: 'New thing' }]]);
  });

  it('explains what to do when nothing resolves', async () => {
    const { repo, config } = await linkedRepo();
    await git(repo, ['checkout', '-q', '-b', 'feature/x']);
    const { client } = stubClient([task('tsk_1', 'sf/add-login')]);
    await expect(resolveRunTarget({ cwd: repo, config, client })).rejects.toThrow(
      /no task in prj_1 uses branch feature\/x; pass --title/,
    );
    await expect(resolveRunTarget({ cwd: repo, config: {}, client })).rejects.toThrow(
      /pass --task ID, or run inside a repo linked with `sf link`/,
    );
  });
});
