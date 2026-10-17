import type { Project, Run, Task } from '@sf/contract';
import { type Column, record, shortTime, table } from './output';

const projectCols: Column<Project>[] = [
  ['id', (p) => p.id],
  ['name', (p) => p.name],
  ['repo', (p) => p.repoUrl],
  ['created', (p) => shortTime(p.createdAt)],
];
const taskCols: Column<Task>[] = [
  ['id', (t) => t.id],
  ['status', (t) => t.status],
  ['title', (t) => t.title],
  ['branch', (t) => t.branch],
];
const runCols: Column<Run>[] = [
  ['id', (r) => r.id],
  ['state', (r) => r.state],
  ['agent', (r) => r.agent],
  ['location', (r) => r.location],
  ['task', (r) => r.taskId],
  ['created', (r) => shortTime(r.createdAt)],
];

export const fmt = {
  projects: (rows: readonly Project[]) => table(rows, projectCols),
  tasks: (rows: readonly Task[]) => table(rows, taskCols),
  runs: (rows: readonly Run[]) => table(rows, runCols),
  project: (p: Project) =>
    record([
      ['id', p.id],
      ['name', p.name],
      ['repo', p.repoUrl],
    ]),
  task: (t: Task) =>
    record([
      ['id', t.id],
      ['project', t.projectId],
      ['title', t.title],
      ['branch', t.branch],
      ['status', t.status],
    ]),
  run: (r: Run) =>
    record([
      ['id', r.id],
      ['task', r.taskId],
      ['state', r.state],
      ['agent', r.agent],
      ['location', r.location],
      ['by', r.startedBy],
      ['created', shortTime(r.createdAt)],
    ]),
};
