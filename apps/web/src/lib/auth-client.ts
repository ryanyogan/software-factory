import { createAuthClient } from 'better-auth/react';

/** Better Auth runs in sf-api; web proxies `/api/auth/*` to it so cookies live on the web origin. */
export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
});
