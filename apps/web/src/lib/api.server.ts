import { env } from 'cloudflare:workers';
import { getRequest } from '@tanstack/react-start/server';

/** Forward the browser request's cookies/headers + origin so the api resolves the same user. */
export function forwardAuth() {
  const request = getRequest();
  return { headers: [...request.headers], origin: new URL(request.url).origin };
}

/** Same `runCommand` path as `POST /v1/commands/:name` (CLI), via the service binding's RPC. */
export async function rpcCommand(name: string, input: unknown) {
  const result = await env.API.command(name, input, forwardAuth());
  // Rebuild a plain, serialisable object (RPC results are proxies with a disposer).
  return JSON.parse(JSON.stringify(result)) as RpcResult;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** `CommandResult` from sf-api, typed as plain JSON so it crosses the server-fn boundary. */
export type RpcResult =
  | { ok: true; data: Json }
  | { ok: false; status: number; error: { code: string; message: string; issues?: Json } };

export interface Viewer {
  name: string;
  email: string;
  /** `dev` = no session, loopback dev bypass (SF_DEV_AUTH) acts for this user. */
  kind: 'session' | 'dev';
}

export async function getViewer(): Promise<Viewer | null> {
  const request = getRequest();
  const url = new URL('/api/auth/get-session', request.url);
  const res = await env.API.fetch(url, {
    headers: { cookie: request.headers.get('cookie') ?? '' },
  });
  const body = (await res.json().catch(() => null)) as {
    user?: { name: string; email: string };
  } | null;
  if (body?.user) return { name: body.user.name, email: body.user.email, kind: 'session' };
  const host = url.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return { name: 'dev', email: 'dev@localhost', kind: 'dev' };
  }
  return null;
}
