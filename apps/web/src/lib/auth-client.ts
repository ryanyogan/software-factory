import { createAuthClient } from 'better-auth/react';
import { deviceAuthorizationClient } from 'better-auth/client/plugins';

/** Better Auth runs in sf-api; web proxies `/api/auth/*` to it so cookies live on the web origin. */
export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  plugins: [deviceAuthorizationClient()],
});

/** Dev-only (SF_DEV_AUTH=1, loopback): get a real session for the dev user. */
export async function devSignIn(): Promise<boolean> {
  const res = await fetch('/api/auth/dev/sign-in', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return res.ok;
}
