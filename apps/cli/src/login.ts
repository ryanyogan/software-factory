/** Better Auth device authorization flow (RFC 8628) against `/api/auth/device/*`. */
export const CLIENT_ID = 'sf-cli';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
}

export interface LoginDeps {
  apiUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onCode: (code: DeviceCode) => void;
}

/** OAuth-style error text from a JSON error body. */
const errText = (b: Record<string, unknown>) =>
  [b.error_description, b.error].find((v): v is string => typeof v === 'string') ?? '';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function postJson(f: typeof fetch, url: string, body: unknown) {
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Requests a code, reports it via `onCode`, polls until approved; returns the session token. */
export async function deviceLogin(deps: LoginDeps): Promise<string> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const codeRes = await postJson(f, `${deps.apiUrl}/api/auth/device/code`, {
    client_id: CLIENT_ID,
  });
  if (!codeRes.res.ok) {
    throw new Error(
      `device code request failed (HTTP ${codeRes.res.status}): ${errText(codeRes.body)}`,
    );
  }
  const code = codeRes.body as unknown as DeviceCode;
  deps.onCode(code);

  let interval = Math.max(1, code.interval || 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const { res, body } = await postJson(f, `${deps.apiUrl}/api/auth/device/token`, {
      grant_type: GRANT,
      device_code: code.device_code,
      client_id: CLIENT_ID,
    });
    if (res.ok && typeof body.access_token === 'string') return body.access_token;
    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5000;
        continue;
      case 'access_denied':
        throw new Error('login denied in the browser');
      case 'expired_token':
        throw new Error('code expired; run `sf login` again');
      default:
        throw new Error(`token request failed (HTTP ${res.status}): ${errText(body)}`);
    }
  }
  throw new Error('code expired; run `sf login` again');
}

/** `GET /api/auth/get-session` with `Authorization: Bearer` (Better Auth bearer plugin). */
export async function fetchSessionUser(
  apiUrl: string,
  token: string,
  f: typeof fetch = fetch,
): Promise<SessionUser | null> {
  const res = await f(`${apiUrl}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`session check failed (HTTP ${res.status})`);
  const body = (await res.json().catch(() => null)) as { user?: SessionUser } | null;
  return body?.user ? { id: body.user.id, email: body.user.email, name: body.user.name } : null;
}
