import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { CommandError } from '@sf/contract';
import { schema } from '@sf/db';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from './context';
import { dispatch } from './dispatch';
import { slugify } from './handlers';

const migrationsFolder = fileURLToPath(new URL('../../db/drizzle', import.meta.url));

let ctx: Ctx;

beforeEach(async () => {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder });
  ctx = { db, userId: 'user_1' };
});

async function seedTask() {
  const project = await dispatch(ctx, 'project.create', {
    name: 'Factory',
    repoUrl: 'https://github.com/acme/factory',
  });
  const task = await dispatch(ctx, 'task.create', {
    projectId: project.id,
    title: 'Add login page!',
  });
  return { project, task };
}

describe('dispatch', () => {
  it('creates and lists projects and tasks', async () => {
    const { project, task } = await seedTask();
    expect(task).toMatchObject({
      projectId: project.id,
      status: 'open',
      branch: 'sf/add-login-page',
    });

    expect((await dispatch(ctx, 'project.list', {})).projects).toHaveLength(1);
    expect((await dispatch(ctx, 'task.list', { projectId: project.id })).tasks).toEqual([task]);
    expect((await dispatch(ctx, 'task.list', { projectId: 'nope' })).tasks).toEqual([]);
  });

  it('starts a run with defaults and reads it back', async () => {
    const { task } = await seedTask();
    const run = await dispatch(ctx, 'run.start', { taskId: task.id, agent: 'claude-code' });
    expect(run).toMatchObject({ state: 'queued', location: 'local', startedBy: 'user_1' });
    expect(await dispatch(ctx, 'run.get', { id: run.id })).toEqual(run);
    expect((await dispatch(ctx, 'run.list', { taskId: task.id })).runs).toEqual([run]);
  });

  it('appends run.started to the events port', async () => {
    const { task } = await seedTask();
    const appended: [string, unknown][] = [];
    ctx.events = {
      appendRunEvent: async (runId, event) => {
        appended.push([runId, event]);
      },
    };
    const run = await dispatch(ctx, 'run.start', { taskId: task.id, agent: 'codex' });
    expect(appended).toEqual([[run.id, { type: 'run.started', payload: run }]]);
  });

  it('creates a project without a repo', async () => {
    const project = await dispatch(ctx, 'project.create', { name: 'Scratch' });
    expect(project.repoUrl).toBeNull();
    expect(await dispatch(ctx, 'project.list', {})).toMatchObject({
      projects: [{ id: project.id, repoUrl: null }],
    });
  });

  it('rejects invalid input', async () => {
    await expect(
      dispatch(ctx, 'project.create', { name: '', repoUrl: 'not a url' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects unknown commands and missing rows', async () => {
    await expect(dispatch(ctx, 'nope.nope', {})).rejects.toMatchObject({ code: 'unknown_command' });
    await expect(dispatch(ctx, 'run.get', { id: 'missing' })).rejects.toBeInstanceOf(CommandError);
    await expect(
      dispatch(ctx, 'run.start', { taskId: 'missing', agent: 'codex' }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('slugify', () => {
  it('falls back for empty titles', () => {
    expect(slugify('!!!')).toBe('task');
  });
});
