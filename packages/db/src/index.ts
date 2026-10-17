import { type AnyD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export { schema };
export * from './schema';

/** Production db: `createD1Db(env.DB)` inside a Worker. */
export function createD1Db(d1: AnyD1Database) {
  return drizzle(d1, { schema });
}
export type D1Db = ReturnType<typeof createD1Db>;
