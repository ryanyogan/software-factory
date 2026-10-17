import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vite-plus';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('../../packages/db/drizzle');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SF_DEV_AUTH: '1',
            BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret',
          },
        },
      }),
    ],
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'] },
  };
});
