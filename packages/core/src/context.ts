import type { schema } from '@sf/db';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Any async Drizzle SQLite db with our schema. In production this is `drizzle(env.DB)`
 * (DrizzleD1Database); tests use libsql in-memory, which has the same async semantics.
 */
export type Db = BaseSQLiteDatabase<'async', unknown, typeof schema>;

export interface Ctx {
  db: Db;
  /** Authenticated user id (Better Auth user.id from stage 3). */
  userId: string;
  /** Injectable clock/ids for deterministic tests. */
  now?: () => Date;
  newId?: (prefix: string) => string;
}
