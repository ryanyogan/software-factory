import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vite-plus/test';
import type { StoredRunEvent } from '../src';

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
  return command('run.start', { taskId: task.body.id, agent: 'codex' });
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
