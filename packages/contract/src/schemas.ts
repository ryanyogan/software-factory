import { z } from 'zod';

/** ISO-8601 timestamp string. Stored as integer ms in D1, serialised as ISO over the wire. */
export const Timestamp = z.iso.datetime();

export const Id = z.string().min(1);

export const Project = z.object({
  id: Id,
  name: z.string().min(1).max(200),
  repoUrl: z.url(),
  createdAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const TaskStatus = z.enum(['open', 'done']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: Id,
  projectId: Id,
  title: z.string().min(1).max(500),
  branch: z.string().min(1),
  status: TaskStatus,
  createdAt: Timestamp,
});
export type Task = z.infer<typeof Task>;

export const Agent = z.enum(['claude-code', 'codex', 'opencode']);
export type Agent = z.infer<typeof Agent>;

export const RunLocation = z.enum(['local', 'cloud']);
export type RunLocation = z.infer<typeof RunLocation>;

export const RunState = z.enum([
  'queued',
  'running',
  'blocked',
  'checks',
  'review',
  'final_review',
  'merged',
  'abandoned',
]);
export type RunState = z.infer<typeof RunState>;

export const Run = z.object({
  id: Id,
  taskId: Id,
  agent: Agent,
  location: RunLocation,
  state: RunState,
  createdAt: Timestamp,
  startedBy: Id,
});
export type Run = z.infer<typeof Run>;
