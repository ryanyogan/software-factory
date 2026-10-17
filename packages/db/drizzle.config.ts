import { defineConfig } from 'drizzle-kit';

// `generate` only needs dialect/schema/out. Migrations are applied by wrangler:
//   cd apps/api && pnpm exec wrangler d1 migrations apply DB --local
// (apps/api/wrangler.jsonc sets migrations_dir to ../../packages/db/drizzle)
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
});
