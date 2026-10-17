// Config used ONLY by the Better Auth schema CLI (`pnpm --filter @sf/api auth:schema`).
// It mirrors src/auth.ts without needing a D1 binding.
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { bearer, deviceAuthorization } from 'better-auth/plugins';

export const auth = betterAuth({
  database: drizzleAdapter({}, { provider: 'sqlite' }),
  socialProviders: { github: { clientId: 'x', clientSecret: 'x' } },
  plugins: [deviceAuthorization(), bearer()],
});
