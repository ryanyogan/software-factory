import { createD1Db, user } from '@sf/db';
import { createAuth, type Auth } from './auth';

export const DEV_USER = { id: 'dev', name: 'Dev User', email: 'dev@localhost' } as const;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

let cachedAuth: { env: Env; auth: Auth } | undefined;

/** One Better Auth instance per isolate (re-created only if the env object changes). */
export function getAuth(env: Env): Auth {
  if (cachedAuth?.env !== env) cachedAuth = { env, auth: createAuth(env) };
  return cachedAuth.auth;
}

/**
 * Dev bypass guard. BOTH must hold:
 *  - `SF_DEV_AUTH === '1'` (only ever set in .dev.vars, never in wrangler.jsonc vars or prod secrets)
 *  - the request origin's hostname is a loopback name (in production the URL hostname is the
 *    routed zone/workers.dev host, so this can't be satisfied there).
 */
export function devAuthAllowed(env: Env, origin: string | undefined): boolean {
  if (env.SF_DEV_AUTH !== '1' || !origin) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

let devUserSeeded = false;
async function ensureDevUser(env: Env): Promise<void> {
  if (devUserSeeded) return;
  await createD1Db(env.DB)
    .insert(user)
    .values({ ...DEV_USER, emailVerified: true })
    .onConflictDoNothing();
  devUserSeeded = true;
}

export interface AuthInput {
  /** Request headers (cookie and/or `Authorization: Bearer <session token>`). */
  headers?: Headers;
  /** Origin of the request as seen by the caller, used only for the dev bypass check. */
  origin?: string;
}

/** Resolve the acting user id, or null if unauthenticated. */
export async function resolveUserId(env: Env, input: AuthInput): Promise<string | null> {
  const headers = input.headers ?? new Headers();
  if (headers.has('authorization') || headers.has('cookie')) {
    const session = await getAuth(env).api.getSession({ headers });
    if (session) return session.user.id;
  }
  if (devAuthAllowed(env, input.origin)) {
    await ensureDevUser(env);
    return DEV_USER.id;
  }
  return null;
}
