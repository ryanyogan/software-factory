import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Better Auth tables (user, session, account, verification, device_code) are generated into
// ./auth-schema.ts by `pnpm --filter @sf/api auth:schema`; do not hand-edit that file.
// `runs.startedBy` holds a Better Auth user.id but has no FK, so core tests need no user rows.
export * from './auth-schema';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repoUrl: text('repo_url'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    branch: text('branch').notNull(),
    status: text('status', { enum: ['open', 'done'] })
      .notNull()
      .default('open'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('tasks_project_idx').on(t.projectId)],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    agent: text('agent', { enum: ['claude-code', 'codex', 'opencode', 'fake'] }).notNull(),
    location: text('location', { enum: ['local', 'cloud'] }).notNull(),
    state: text('state', {
      enum: [
        'queued',
        'running',
        'blocked',
        'checks',
        'review',
        'final_review',
        'merged',
        'abandoned',
        'failed',
      ],
    })
      .notNull()
      .default('queued'),
    startedBy: text('started_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    // Stage 8 (0003_run_lifecycle): plain ADD COLUMNs. Legacy rows get prompt '' / open_pr 1.
    prompt: text('prompt').notNull().default(''),
    openPr: integer('open_pr', { mode: 'boolean' }).notNull().default(true),
    claimedBy: text('claimed_by'),
    claimedAt: integer('claimed_at', { mode: 'timestamp_ms' }),
    sessionId: text('session_id'),
    prUrl: text('pr_url'),
    costUsd: real('cost_usd'),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('runs_task_idx').on(t.taskId)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
