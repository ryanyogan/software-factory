import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { createD1Db, schema } from '@sf/db';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { bearer, deviceAuthorization } from 'better-auth/plugins';

/** Client ids allowed to use the device flow (`sf login`). */
export const DEVICE_CLIENT_IDS = new Set(['sf-cli']);

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

/** Shared options (minus database/secrets) so the schema CLI sees the same plugins. */
export const authPlugins = () =>
  [
    deviceAuthorization({
      verificationUri: '/device',
      validateClient: (clientId) => DEVICE_CLIENT_IDS.has(clientId),
    }),
    bearer(),
  ] satisfies BetterAuthOptions['plugins'];

export function createAuth(env: AuthEnv) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(createD1Db(env.DB), { provider: 'sqlite', schema }),
    socialProviders:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {
            github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
          }
        : {},
    plugins: authPlugins(),
  });
}

export type Auth = ReturnType<typeof createAuth>;
