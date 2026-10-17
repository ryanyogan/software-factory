import { createD1Db, user } from '@sf/db';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { isLoopback } from './origins';

export const DEV_USER = { id: 'dev', name: 'Dev User', email: 'dev@localhost' } as const;

export async function ensureDevUser(db: D1Database): Promise<void> {
  await createD1Db(db)
    .insert(user)
    .values({ ...DEV_USER, emailVerified: true })
    .onConflictDoNothing();
}

/**
 * Dev-only: `POST /api/auth/dev/sign-in` issues a REAL Better Auth session (cookie) for the dev
 * user, so flows that need a session (device approval on /device) work locally without GitHub.
 * Registered only when SF_DEV_AUTH=1, and refuses non-loopback hosts.
 */
export function devSignIn(db: D1Database) {
  return {
    id: 'sf-dev-sign-in',
    endpoints: {
      devSignIn: createAuthEndpoint('/dev/sign-in', { method: 'POST' }, async (ctx) => {
        if (!isLoopback(ctx.request?.url)) throw new APIError('FORBIDDEN');
        await ensureDevUser(db);
        const devUser = await ctx.context.internalAdapter.findUserById(DEV_USER.id);
        if (!devUser) throw new APIError('INTERNAL_SERVER_ERROR');
        const session = await ctx.context.internalAdapter.createSession(devUser.id);
        await setSessionCookie(ctx, { session, user: devUser });
        return ctx.json({ user: { id: devUser.id, name: devUser.name, email: devUser.email } });
      }),
    },
  } satisfies BetterAuthPlugin;
}
