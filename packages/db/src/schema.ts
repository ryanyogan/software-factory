import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// NOTE (stage 3): Better Auth tables (user, session, account, verification, deviceCode)
// are generated into src/auth-schema.ts and re-exported from here. `runs.startedBy`
// will then reference user.id; for now it is a plain text user id.

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  repoUrl: text('repo_url').notNull(),
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
    agent: text('agent', { enum: ['claude-code', 'codex', 'opencode'] }).notNull(),
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
      ],
    })
      .notNull()
      .default('queued'),
    startedBy: text('started_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('runs_task_idx').on(t.taskId)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
