import type { D1Migration } from 'cloudflare:test';

// Test-only bindings (see vite.config.ts `miniflare.bindings`).
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
