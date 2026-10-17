import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vite-plus/test';
import type { StoredRunEvent } from '../src';
import { wsAuthHeaders } from '../src/origins';

const LOCAL = 'http://localhost:8787';

async function command(name: string, input: unknown, base = LOCAL) {
  const res = await exports.default.fetch(`${base}/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function seedRun() {
  const project = await command('project.create', {
    name: 'P',
    repoUrl: 'https://github.com/acme/p',
  });
  const task = await command('task.create', { projectId: project.body.id, title: 'T' });
  return command('run.start', { taskId: task.body.id, agent: 'codex', prompt: 'do it' });
}

describe('HTTP /v1', () => {
  it('serves health', async () => {
    const res = await exports.default.fetch(`${LOCAL}/v1/health`);
    expect(await res.json()).toEqual({ ok: true, service: 'sf-api' });
  });

  it('runs project → task → run via the dev bypass, attributed to the dev user', async () => {
    const run = await seedRun();
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ state: 'queued', startedBy: 'dev' });
    const list = await command('run.list', { taskId: run.body.taskId });
    expect(list.body.runs).toHaveLength(1);
  });

  it('maps CommandError to HTTP status', async () => {
    expect((await command('nope', {})).status).toBe(404);
    expect((await command('task.create', {})).status).toBe(400);
    expect((await command('run.get', { id: 'missing' })).body).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('refuses the dev bypass on a non-loopback host', async () => {
    const res = await command('project.list', {}, 'https://sf.example.com');
    expect(res).toEqual({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'sign in required' } },
    });
  });
});

describe('RunLog', () => {
  it('run.start appends run.started to the run log', async () => {
    const run = await seedRun();
    const events: StoredRunEvent[] = await env.RUN_LOG.getByName(String(run.body.id)).list();

    expect(events).toMatchObject([{ seq: 1, type: 'run.started', payload: { id: run.body.id } }]);
  });

  it('replays from ?since= over a WebSocket', async () => {
    const stub = env.RUN_LOG.getByName('run_ws');
    await stub.append({ type: 'a', payload: 1 });
    await stub.append({ type: 'b', payload: 2 });
    const res = await exports.default.fetch(`${LOCAL}/v1/runs/run_ws/events?since=1`, {
      headers: { upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const received: string[] = [];
    const got = new Promise<void>((resolve) => {
      ws.addEventListener('message', (m) => {
        received.push(String(m.data));
        if (received.length === 2) resolve();
      });
    });
    ws.accept();
    await stub.append({ type: 'c', payload: 3 });
    await got;
    expect(received.map((m) => (JSON.parse(m) as StoredRunEvent).type)).toEqual(['b', 'c']);
    ws.close();
  });
});

describe('ApiRpc', () => {
  it('runs the same command path as HTTP', async () => {
    const rpc = exports.ApiRpc as unknown as {
      command(name: string, input: unknown, auth?: object): Promise<unknown>;
    };
    expect(await rpc.command('project.list', {}, { origin: LOCAL })).toMatchObject({
      ok: true,
      data: { projects: expect.any(Array) },
    });
    expect(await rpc.command('project.list', {}, { origin: 'https://sf.example.com' })).toEqual({
      ok: false,
      status: 401,
      error: { code: 'unauthorized', message: 'sign in required' },
    });
  });
});

describe('WebSocket origin guard (CSWSH)', () => {
  const REMOTE = 'https://sf.example.com';

  async function seedSession(): Promise<string> {
    const token = `tok_${crypto.randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    await env.DB.prepare(
      'INSERT OR IGNORE INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 1)',
    )
      .bind('u_ws', 'WS User', 'ws@example.com')
      .run();
    await env.DB.prepare(
      'INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(`ses_${token}`, now + 3_600_000, token, now, 'u_ws')
      .run();
    return token;
  }

  function upgrade(base: string, headers: Record<string, string>) {
    return exports.default.fetch(`${base}/v1/runs/run_guard/events`, {
      headers: { upgrade: 'websocket', ...headers },
    });
  }

  it('accepts an allowlisted Origin', async () => {
    const res = await upgrade(LOCAL, { origin: 'http://localhost:5173' });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it('rejects a foreign Origin with 403, even with valid credentials', async () => {
    const token = await seedSession();
    const res = await upgrade(LOCAL, {
      origin: 'https://evil.example',
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('authenticates a no-Origin client (CLI) via Bearer', async () => {
    const token = await seedSession();
    const res = await upgrade(REMOTE, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
    expect((await upgrade(REMOTE, {})).status).toBe(401);
  });

  it('ignores cookies when no Origin is sent', () => {
    const req = new Request(`${REMOTE}/x`, {
      headers: { cookie: 'better-auth.session_token=x', authorization: 'Bearer y' },
    });
    const headers = wsAuthHeaders({}, req);
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).has('cookie')).toBe(false);
    expect((headers as Headers).get('authorization')).toBe('Bearer y');
  });
});

describe('dev sign-in (SF_DEV_AUTH)', () => {
  const signIn = (base: string) =>
    exports.default.fetch(`${base}/api/auth/dev/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: '{}',
    });

  it('issues a real session cookie for the dev user on loopback', async () => {
    const res = await signIn(LOCAL);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('better-auth.session_token=');
  });

  it('is refused on a non-loopback host', async () => {
    expect((await signIn('https://sf.example.com')).status).not.toBe(200);
  });
});

/* ---------------------------------------------------------------- stage 8: run lifecycle */

const M1 = 'mch_test_1';

/** Collects JSON frames from a client WebSocket; `next(pred)` waits for a matching frame. */
function frames(ws: WebSocket) {
  const got: Record<string, unknown>[] = [];
  const waiters: {
    pred: (f: Record<string, unknown>) => boolean;
    resolve: (f: Record<string, unknown>) => void;
  }[] = [];
  ws.addEventListener('message', (m) => {
    if (typeof m.data !== 'string' || m.data === 'pong') return;
    const f = JSON.parse(m.data) as Record<string, unknown>;
    got.push(f);
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  });
  ws.accept();
  return {
    got,
    next(pred: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      const hit = got.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(got)}`)), 2000);
      });
    },
  };
}

async function openWs(path: string, headers: Record<string, string> = {}) {
  const res = await exports.default.fetch(`${LOCAL}${path}`, {
    headers: { upgrade: 'websocket', ...headers },
  });
  return res;
}

async function claimedRun() {
  const run = await seedRun();
  const id = String(run.body.id);
  const claim = await command('run.claim', { id, machineId: M1 });
  expect(claim.status).toBe(200);
  return { id };
}

const agentMsg = (text: string, key?: string) => ({
  type: 'agent',
  payload: { type: 'message', role: 'assistant', text },
  emittedAt: Date.now(),
  ...(key ? { key } : {}),
});

describe('run.claim over HTTP', () => {
  it('returns 409 conflict for a second claim', async () => {
    const run = await seedRun();
    const id = String(run.body.id);
    expect((await command('run.claim', { id, machineId: M1 })).body).toMatchObject({
      state: 'running',
      claimedBy: M1,
    });
    const second = await command('run.claim', { id, machineId: 'mch_other' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: 'conflict' } });
  });
});

describe('RunLog writer socket', () => {
  it('rejects a writer that is not the claiming machine (403)', async () => {
    const { id } = await claimedRun();
    const res = await openWs(`/v1/runs/${id}/events`, { 'x-sf-machine': 'mch_intruder' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('appends batched agent events, acks, fans out to viewers, and replays', async () => {
    const { id } = await claimedRun(); // seqs 1-3: run.started, run.claimed, run.state
    const viewerRes = await openWs(`/v1/runs/${id}/events?since=3`);
    const viewer = frames(viewerRes.webSocket!);
    const writerRes = await openWs(`/v1/runs/${id}/events?since=3`, { 'x-sf-machine': M1 });
    expect(writerRes.status).toBe(101);
    const writer = frames(writerRes.webSocket!);

    writerRes.webSocket!.send(
      JSON.stringify({ type: 'append', events: [agentMsg('one', 'k1'), agentMsg('two')] }),
    );
    expect(await writer.next((f) => f.type === 'ack')).toEqual({ type: 'ack', seqs: [4, 5] });
    await viewer.next((f) => f.seq === 5);
    expect(viewer.got.map((f) => f.seq)).toEqual([4, 5]);
    // the writer does not get its own events echoed back
    expect(writer.got.filter((f) => typeof f.seq === 'number')).toEqual([]);

    // resend of key k1 is deduped
    writerRes.webSocket!.send(JSON.stringify({ type: 'append', events: [agentMsg('one', 'k1')] }));
    expect(
      await writer.next((f) => f.type === 'ack' && (f.seqs as number[])[0] === 4),
    ).toBeTruthy();

    // invalid frames / forged types get an error frame
    writerRes.webSocket!.send(
      JSON.stringify({ type: 'append', events: [{ type: 'user.message', payload: {} }] }),
    );
    await writer.next((f) => f.type === 'error' && f.code === 'invalid_input');
    // viewers are read-only
    viewerRes.webSocket!.send(JSON.stringify({ type: 'append', events: [agentMsg('x')] }));
    await viewer.next((f) => f.type === 'error' && f.code === 'forbidden');

    // replay on reconnect
    const again = await openWs(`/v1/runs/${id}/events?since=3`);
    const replay = frames(again.webSocket!);
    await replay.next((f) => f.seq === 5);
    expect(replay.got.map((f) => [f.seq, f.type])).toEqual([
      [4, 'agent'],
      [5, 'agent'],
    ]);
    for (const ws of [viewerRes, writerRes, again]) ws.webSocket!.close();
  });

  it('delivers follow-ups and cancel requests to the daemon socket', async () => {
    const { id } = await claimedRun();
    const writerRes = await openWs(`/v1/runs/${id}/events?since=3`, { 'x-sf-machine': M1 });
    const writer = frames(writerRes.webSocket!);
    const sent = await command('run.message', { id, text: 'also add tests' });
    expect(sent.status).toBe(200);
    const msg = await writer.next((f) => f.type === 'user.message');
    expect(msg).toMatchObject({
      seq: 4,
      payload: { text: 'also add tests', author: { userId: 'dev' } },
    });
    expect((await command('run.cancel', { id })).body).toMatchObject({ state: 'running' });
    await writer.next((f) => f.type === 'run.cancel_requested');
    writerRes.webSocket!.close();
  });
});

describe('HTTP event endpoints', () => {
  it('POST /v1/runs/:id/events appends a batch (run.append) and GET lists as JSON', async () => {
    const { id } = await claimedRun();
    const post = (machineId: string) =>
      exports.default.fetch(`${LOCAL}/v1/runs/${id}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ machineId, events: [agentMsg('a'), agentMsg('b')] }),
      });
    const ok = await post(M1);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ seqs: [4, 5] });
    expect((await post('mch_nope')).status).toBe(403);

    const list = await exports.default.fetch(`${LOCAL}/v1/runs/${id}/events?since=3`);
    expect(await list.json()).toMatchObject({
      events: [
        { seq: 4, type: 'agent' },
        { seq: 5, type: 'agent' },
      ],
    });
    const viaCommand = await command('run.events', { id, since: 4 });
    expect(viaCommand.body).toMatchObject({ events: [{ seq: 5 }] });
  });
});

describe('ProjectRoom', () => {
  it('broadcasts run.queued on run.start and state changes to subscribed daemons', async () => {
    const project = await command('project.create', { name: 'Room' });
    const projectId = String(project.body.id);
    const task = await command('task.create', { projectId, title: 'T' });
    const res = await openWs(`/v1/projects/${projectId}/room`, { 'x-sf-machine': M1 });
    expect(res.status).toBe(101);
    const room = frames(res.webSocket!);
    expect(await env.PROJECT_ROOM.getByName(projectId).connections()).toEqual({
      viewer: 0,
      daemon: 1,
    });

    const run = await command('run.start', { taskId: task.body.id, agent: 'codex', prompt: 'go' });
    const queued = await room.next((f) => f.type === 'run.queued');
    expect(queued).toMatchObject({ run: { id: run.body.id, prompt: 'go', state: 'queued' } });

    await command('run.claim', { id: run.body.id, machineId: M1 });
    expect(await room.next((f) => f.type === 'run.state')).toMatchObject({
      from: 'queued',
      to: 'running',
      run: { claimedBy: M1 },
    });
    res.webSocket!.close();
  });
});
