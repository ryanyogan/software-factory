import { type CommandName, CommandError, type CommandOutput, type ParsedInput } from '@sf/contract';
import { projects, runs, tasks, type ProjectRow, type RunRow, type TaskRow } from '@sf/db';
import { desc, eq } from 'drizzle-orm';
import type { Ctx } from './context';
import { runHandlers } from './run-lifecycle';
import { newId, now, toRun } from './rows';

export type Handler<N extends CommandName> = (
  ctx: Ctx,
  input: ParsedInput<N>,
) => Promise<CommandOutput<N>>;

export type Handlers = { [N in CommandName]: Handler<N> };

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'task';
}

const toProject = (r: ProjectRow): CommandOutput<'project.create'> => ({
  id: r.id,
  name: r.name,
  repoUrl: r.repoUrl,
  createdAt: r.createdAt.toISOString(),
});

const toTask = (r: TaskRow): CommandOutput<'task.create'> => ({
  id: r.id,
  projectId: r.projectId,
  title: r.title,
  branch: r.branch,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
});

export const handlers: Handlers = {
  async 'project.create'(ctx, input) {
    const row: ProjectRow = {
      id: newId(ctx, 'prj'),
      name: input.name,
      repoUrl: input.repoUrl ?? null,
      createdAt: now(ctx),
    };
    await ctx.db.insert(projects).values(row);
    return toProject(row);
  },

  async 'project.list'(ctx) {
    const rows = await ctx.db.select().from(projects).orderBy(desc(projects.createdAt));
    return { projects: rows.map(toProject) };
  },

  async 'task.create'(ctx, input) {
    const [project] = await ctx.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    if (!project) throw new CommandError('not_found', `project ${input.projectId} not found`);

    const row: TaskRow = {
      id: newId(ctx, 'tsk'),
      projectId: input.projectId,
      title: input.title,
      branch: input.branch ?? `sf/${slugify(input.title)}`,
      status: 'open',
      createdAt: now(ctx),
    };
    await ctx.db.insert(tasks).values(row);
    return toTask(row);
  },

  async 'task.list'(ctx, input) {
    const q = ctx.db.select().from(tasks);
    const rows = await (
      input.projectId ? q.where(eq(tasks.projectId, input.projectId)) : q
    ).orderBy(desc(tasks.createdAt));
    return { tasks: rows.map(toTask) };
  },

  async 'run.start'(ctx, input) {
    const [task] = await ctx.db
      .select({ id: tasks.id, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, input.taskId));
    if (!task) throw new CommandError('not_found', `task ${input.taskId} not found`);

    const row: RunRow = {
      id: newId(ctx, 'run'),
      taskId: input.taskId,
      agent: input.agent,
      location: input.location,
      state: 'queued',
      prompt: input.prompt,
      openPr: input.openPr,
      startedBy: ctx.userId,
      createdAt: now(ctx),
      claimedBy: null,
      claimedAt: null,
      sessionId: null,
      prUrl: null,
      costUsd: null,
      endedAt: null,
    };
    await ctx.db.insert(runs).values(row);
    const run = toRun(row);
    await ctx.events?.append(run.id, [{ type: 'run.started', payload: run }]);
    if (run.location === 'local') {
      await ctx.events?.notifyProject(task.projectId, { type: 'run.queued', run });
    }
    return run;
  },

  async 'run.get'(ctx, input) {
    const [row] = await ctx.db.select().from(runs).where(eq(runs.id, input.id));
    if (!row) throw new CommandError('not_found', `run ${input.id} not found`);
    return toRun(row);
  },

  async 'run.list'(ctx, input) {
    const q = ctx.db.select().from(runs);
    const rows = await (input.taskId ? q.where(eq(runs.taskId, input.taskId)) : q).orderBy(
      desc(runs.createdAt),
    );
    return { runs: rows.map(toRun) };
  },

  ...runHandlers,
};
