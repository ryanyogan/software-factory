import type { ProjectNotice, StoredRunEvent } from '@sf/contract';
import type { schema } from '@sf/db';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Any async Drizzle SQLite db with our schema. In production this is `drizzle(env.DB)`
 * (DrizzleD1Database); tests use libsql in-memory, which has the same async semantics.
 */
export type Db = BaseSQLiteDatabase<'async', unknown, typeof schema>;

/** An event to append to a run's append-only log (RunLog Durable Object in the api). */
export interface RunEventInput {
  type: string;
  payload: unknown;
  /** ms, stamped by the sender (daemon) for latency measurement. */
  emittedAt?: number;
  /** Idempotency key: appending a key that already exists returns the original event. */
  key?: string;
}

/** Platform port for run events + project fan-out, so core stays free of Cloudflare APIs. */
export interface EventsPort {
  /** Append in order; returns the stored events (deduped keys return the original). */
  append(runId: string, events: RunEventInput[]): Promise<StoredRunEvent[]>;
  list(runId: string, since: number, limit: number): Promise<StoredRunEvent[]>;
  /** Broadcast to everyone subscribed to the project's room (daemons, GUIs). */
  notifyProject(projectId: string, notice: ProjectNotice): Promise<void>;
}

export interface Ctx {
  db: Db;
  /** Authenticated user id (Better Auth user.id from stage 3). */
  userId: string;
  /** Injectable clock/ids for deterministic tests. */
  now?: () => Date;
  newId?: (prefix: string) => string;
  /**
   * Where run events go. Commands that write events tolerate its absence (they just skip it);
   * `run.events` / `run.message` / `run.append` fail with `internal` without one.
   */
  events?: EventsPort;
}
