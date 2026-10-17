import type { schema } from '@sf/db';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Any async Drizzle SQLite db with our schema. In production this is `drizzle(env.DB)`
 * (DrizzleD1Database); tests use libsql in-memory, which has the same async semantics.
 */
export type Db = BaseSQLiteDatabase<'async', unknown, typeof schema>;

/** An event appended to a run's append-only log (RunLog Durable Object in the api). */
export interface RunEvent {
  type: string;
  payload: unknown;
}

/** Optional platform port for run events, so core stays free of Cloudflare APIs. */
export interface EventsPort {
  appendRunEvent(runId: string, event: RunEvent): Promise<void>;
}

export interface Ctx {
  db: Db;
  /** Authenticated user id (Better Auth user.id from stage 3). */
  userId: string;
  /** Injectable clock/ids for deterministic tests. */
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** Where run events go. Omitted in tests / surfaces without a log. */
  events?: EventsPort;
}
