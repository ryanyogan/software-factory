/** Browser origins allowed to talk to the api with cookies (web app, local api). */
export const DEFAULT_WEB_ORIGINS = ['http://localhost:5173', 'http://localhost:8787'] as const;

/** Parse `WEB_ORIGIN` (comma-separated) into normalised origins; falls back to the dev defaults. */
export function webOrigins(env: { WEB_ORIGIN?: string }): string[] {
  const raw = env.WEB_ORIGIN?.trim();
  const list = raw ? raw.split(',') : [...DEFAULT_WEB_ORIGINS];
  const out: string[] = [];
  for (const entry of list) {
    try {
      out.push(new URL(entry.trim()).origin);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

export function originAllowed(env: { WEB_ORIGIN?: string }, origin: string): boolean {
  try {
    return webOrigins(env).includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

/**
 * Cross-Site WebSocket Hijacking guard for upgrade routes. Browsers always send `Origin` on a
 * WebSocket handshake and attach cookies, so:
 *  - `Origin` present → must be allowlisted (else 403); cookies are then trusted.
 *  - no `Origin` (CLI, server-to-server) → cookies are dropped; only `Authorization: Bearer`
 *    (or the loopback dev bypass) can authenticate.
 * Returns the headers to authenticate with, or a 403 response.
 */
export function wsAuthHeaders(env: { WEB_ORIGIN?: string }, req: Request): Headers | Response {
  const origin = req.headers.get('origin');
  if (origin !== null) {
    if (!originAllowed(env, origin)) {
      return Response.json(
        { error: { code: 'forbidden', message: 'origin not allowed' } },
        { status: 403 },
      );
    }
    return req.headers;
  }
  const headers = new Headers(req.headers);
  headers.delete('cookie');
  return headers;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when the origin/URL's hostname is a loopback name (dev bypass guard). */
export function isLoopback(originOrUrl: string | undefined): boolean {
  if (!originOrUrl) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(originOrUrl).hostname);
  } catch {
    return false;
  }
}
