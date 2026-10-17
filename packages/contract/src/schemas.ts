import { z } from 'zod';

/** ISO-8601 timestamp string. Stored as integer ms in D1, serialised as ISO over the wire. */
export const Timestamp = z.iso.datetime();

export const Id = z.string().min(1);

export const Project = z.object({
  id: Id,
  name: z.string().min(1).max(200),
  repoUrl: z.url().nullable(),
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

/** `fake` is the scripted test agent (@sf/adapters); the web GUI only offers it on loopback (dev). */
export const Agent = z.enum(['claude-code', 'codex', 'opencode', 'fake']);
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
  'failed',
]);
export type RunState = z.infer<typeof RunState>;

/** A daemon's self-chosen machine id (stable per machine, stored in the daemon's config). */
export const MachineId = z
  .string()
  .regex(/^[\w.:-]{1,128}$/, 'machine id: 1-128 of [A-Za-z0-9_.:-]');
export type MachineId = z.infer<typeof MachineId>;

/** The instruction for the agent. Legacy (Phase 0) runs have `''`. */
export const Prompt = z.string().max(100_000);

export const Run = z.object({
  id: Id,
  taskId: Id,
  agent: Agent,
  location: RunLocation,
  state: RunState,
  prompt: Prompt,
  /** Open a draft PR when the run ends (daemon decides if the repo has a GitHub remote). */
  openPr: z.boolean(),
  createdAt: Timestamp,
  /** Owner: the user who started the run. Only the owner (and their daemon) may change it. */
  startedBy: Id,
  /** Machine id of the daemon that claimed the run (`run.claim`), or null. */
  claimedBy: MachineId.nullable(),
  claimedAt: Timestamp.nullable(),
  /** Agent session/thread id (for resume), reported by the daemon. */
  sessionId: z.string().min(1).nullable(),
  prUrl: z.url().nullable(),
  /** Cumulative agent cost in USD, when the agent reports it (Codex does not). */
  costUsd: z.number().nonnegative().nullable(),
  /** When the run last left `running` for review/failed/abandoned/merged. */
  endedAt: Timestamp.nullable(),
});
export type Run = z.infer<typeof Run>;
