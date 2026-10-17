import { Hono } from 'hono';
import { runCommand } from './commands';
import { wsAuthHeaders } from './origins';
import { getAuth, resolveUserId } from './session';

/** The HTTP surface (CLI REST, auth, WebSockets). Shared by the default export and `ApiRpc.fetch`. */
const app = new Hono<{ Bindings: Env }>();

app.get('/v1/health', (c) => c.json({ ok: true, service: 'sf-api' }));

app.on(['GET', 'POST'], '/api/auth/*', (c) => getAuth(c.env).handler(c.req.raw));

app.post('/v1/commands/:name', async (c) => {
  let input: unknown = {};
  const text = await c.req.text();
  if (text) {
    try {
      input = JSON.parse(text);
    } catch {
      return c.json({ error: { code: 'invalid_input', message: 'body must be JSON' } }, 400);
    }
  }
  const origin = new URL(c.req.url).origin;
  const result = await runCommand(c.env, c.req.param('name'), input, {
    headers: c.req.raw.headers,
    origin,
  });
  if (result.ok) return c.json(result.data as object);
  return Response.json({ error: result.error }, { status: result.status });
});

/** Auth for WebSocket upgrades: Origin allowlist (CSWSH guard), then cookie/bearer/dev bypass. */
async function requireWsUser(env: Env, req: Request): Promise<Response | null> {
  const headers = wsAuthHeaders(env, req);
  if (headers instanceof Response) return headers;
  const userId = await resolveUserId(env, {
    headers,
    origin: new URL(req.url).origin,
  });
  return userId
    ? null
    : Response.json(
        { error: { code: 'unauthorized', message: 'sign in required' } },
        { status: 401 },
      );
}

// Live run events (WebSocket). `?since=<seq>` replays events after that seq first.
app.get('/v1/runs/:id/events', async (c) => {
  const denied = await requireWsUser(c.env, c.req.raw);
  if (denied) return denied;
  return c.env.RUN_LOG.getByName(c.req.param('id')).fetch(c.req.raw);
});

// Project room (WebSocket relay skeleton).
app.get('/v1/projects/:id/room', async (c) => {
  const denied = await requireWsUser(c.env, c.req.raw);
  if (denied) return denied;
  return c.env.PROJECT_ROOM.getByName(c.req.param('id')).fetch(c.req.raw);
});

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'no such route' } }, 404));

export default app;
