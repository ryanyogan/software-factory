import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

export default defineConfig(({ mode }) => ({
  resolve: { tsconfigPaths: true },
  server: { port: 5173, strictPort: true },
  // Unit tests are plain Node (pure helpers); the Workers/Start plugins only run for dev/build.
  plugins:
    mode === 'test'
      ? []
      : [
          cloudflare({
            viteEnvironment: { name: 'ssr' },
            // sf-api runs in the same Miniflare instance as an auxiliary worker.
            auxiliaryWorkers: [{ configPath: '../api/wrangler.jsonc' }],
            // Share local D1/DO state with `wrangler dev` in apps/api (one DB, one migrate command).
            // SF_STATE_DIR points it elsewhere (the gates use a temp dir so they never touch dev data).
            persistState: {
              path:
                process.env.SF_STATE_DIR ||
                fileURLToPath(new URL('../api/.wrangler/state', import.meta.url)),
            },
          }),
          tailwindcss(),
          tanstackStart(),
          viteReact(),
        ],
  test: { include: ['src/**/*.test.ts'] },
}));
