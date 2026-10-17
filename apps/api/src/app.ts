import { CommandError, MachineId } from '@sf/contract';
import { authorizeWriter } from '@sf/core';
import { createD1Db } from '@sf/db';
import { Hono } from 'hono';
import { type CommandResult, fail, runCommand } from './commands';
import { SF_HEADERS } from './durable/identity';
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
async function requireWsUser(env: Env, req: Request): Promise<string | Response> {
  const headers = wsAuthHeaders(env, req);
  if (headers instanceof Response) return headers;
  const userId = await resolveUserId(env, { headers, origin: new URL(req.url).origin });
  return (
    userId ??
    Response.json({ error: { code: 'unauthorized', message: 'sign in required' } }, { status: 401 })
  );
}

const isUpgrade = (req: Request) => req.headers.get('upgrade')?.toLowerCase() === 'websocket';

/** Copy of the upgrade request with client `x-sf-*` stripped and the verified identity set. */
function forwardWithIdentity(
  req: Request,
  identity: { role: string; userId: string; machineId?: string | null },
): Request {
  const fwd = new Request(req);
  for (const name of [...fwd.headers.keys()])
    if (name.startsWith('x-sf-')) fwd.headers.delete(name);
  fwd.headers.set(SF_HEADERS.role, identity.role);
  fwd.headers.set(SF_HEADERS.user, identity.userId);
  if (identity.machineId) fwd.headers.set(SF_HEADERS.machine, identity.machineId);
  return fwd;
}

function commandResponse(result: CommandResult): Response {
  if (result.ok) return Response.json(result.data);
  return Response.json({ error: result.error }, { status: result.status });
}

const authOf = (c: { req: { raw: Request; url: string } }) => ({
  headers: c.req.raw.headers,
  origin: new URL(c.req.url).origin,
});

/**
 * Run events.
 *  - WebSocket upgrade: live tail, replaying seq > `?since=`. With `x-sf-machine: <id>` the socket is
 *    a WRITER (must be the run owner's claiming machine, else 403) that may send `append` frames.
 *  - Plain GET (no upgrade): JSON `run.events` (`?since=&limit=`), same as the command.
 */
app.get('/v1/runs/:id/events', async (c) => {
  const runId = c.req.param('id');
  if (!isUpgrade(c.req.raw)) {
    const since = Number(c.req.query('since') ?? 0) || 0;
    const limit = c.req.query('limit');
    const input = { id: runId, since, ...(limit ? { limit: Number(limit) } : {}) };
    return commandResponse(await runCommand(c.env, 'run.events', input, authOf(c)));
  }
  const userId = await requireWsUser(c.env, c.req.raw);
  if (userId instanceof Response) return userId;
  const machineId = c.req.header(SF_HEADERS.machine) ?? null;
  if (machineId !== null) {
    try {
      await authorizeWriter({ db: createD1Db(c.env.DB), userId }, runId, machineId);
    } catch (err) {
      if (err instanceof CommandError) return commandResponse(fail(err));
      throw err;
    }
  }
  const role = machineId === null ? 'viewer' : 'writer';
  return c.env.RUN_LOG.getByName(runId).fetch(
    forwardWithIdentity(c.req.raw, { role, userId, machineId }),
  );
});

/** HTTP batch fallback for the daemon writer socket = the `run.append` command. */
app.post('/v1/runs/:id/events', async (c) => {
  let body: { machineId?: unknown; events?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: { code: 'invalid_input', message: 'body must be JSON' } }, 400);
  }
  const input = {
    id: c.req.param('id'),
    machineId: body.machineId ?? c.req.header(SF_HEADERS.machine),
    events: body.events,
  };
  return commandResponse(await runCommand(c.env, 'run.append', input, authOf(c)));
});

/**
 * Project room (WebSocket): server → client `ProjectNotice`s. Daemons send `x-sf-machine` (tagged
 * `daemon`); everyone else is a viewer. Any signed-in user may subscribe (no project ACLs yet).
 */
app.get('/v1/projects/:id/room', async (c) => {
  const userId = await requireWsUser(c.env, c.req.raw);
  if (userId instanceof Response) return userId;
  const machineId = c.req.header(SF_HEADERS.machine) ?? null;
  if (machineId !== null && !MachineId.safeParse(machineId).success) {
    return c.json({ error: { code: 'invalid_input', message: 'bad x-sf-machine' } }, 400);
  }
  const role = machineId === null ? 'viewer' : 'daemon';
  return c.env.PROJECT_ROOM.getByName(c.req.param('id')).fetch(
    forwardWithIdentity(c.req.raw, { role, userId, machineId }),
  );
});

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'no such route' } }, 404));

export default app;
