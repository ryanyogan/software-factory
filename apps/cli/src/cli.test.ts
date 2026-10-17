import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommandDef, runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import project from './commands/project';
import run from './commands/run';
import task from './commands/task';
import { readConfig, resolveApiUrl, writeConfig } from './config';
import { deviceLogin } from './login';
import { table } from './output';
import { eventsUrl, formatEvent } from './watch';

const NOW = '2026-10-17T11:15:54.123Z';
const project1 = { id: 'prj_1', name: 'Demo', repoUrl: 'https://github.com/a/b', createdAt: NOW };
const task1 = {
  id: 'tsk_1',
  projectId: 'prj_1',
  title: 'Add login',
  branch: 'sf/add-login',
  status: 'open',
  createdAt: NOW,
};
const run1 = {
  id: 'run_1',
  taskId: 'tsk_1',
  agent: 'codex',
  location: 'cloud',
  state: 'queued',
  prompt: 'Add a login page',
  openPr: true,
  createdAt: NOW,
  startedBy: 'dev',
  claimedBy: null,
  claimedAt: null,
  sessionId: null,
  prUrl: null,
  costUsd: null,
  endedAt: null,
};

const RESPONSES: Record<string, unknown> = {
  'project.create': project1,
  'project.list': { projects: [project1] },
  'task.create': task1,
  'task.list': { tasks: [task1] },
  'run.start': run1,
  'run.list': { runs: [run1] },
  'run.get': run1,
  'run.message': { event: { seq: 7, type: 'user.message', payload: {}, at: 1 } },
  'run.cancel': run1,
};

let calls: { url: string; body: unknown; auth: string | null }[];
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  calls = [];
  stdout = [];
  stderr = [];
  vi.stubEnv('SF_CONFIG_DIR', await mkdtemp(join(tmpdir(), 'sf-cli-')));
  vi.stubEnv('SF_API_URL', '');
  vi.stubEnv('SF_TOKEN', '');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const name = url.split('/v1/commands/')[1]!;
    const auth = new Headers(init.headers).get('authorization');
    calls.push({ url, body: JSON.parse(init.body as string), auth });
    if (name === 'run.get' && (JSON.parse(init.body as string) as { id: string }).id === 'nope')
      return Response.json({ error: { code: 'not_found', message: 'run nope' } }, { status: 404 });
    return Response.json(RESPONSES[name]);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (stdout.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (stderr.push(String(s)), true));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

async function sf(cmd: CommandDef<any>, rawArgs: string[]) {
  await runCommand(cmd, { rawArgs });
  return calls.at(-1);
}

describe('arg → command mapping', () => {
  it.each([
    [
      project,
      ['create', '--name', 'Demo', '--repo', 'https://github.com/a/b'],
      'project.create',
      { name: 'Demo', repoUrl: 'https://github.com/a/b' },
    ],
    [project, ['create', '--name', 'Demo'], 'project.create', { name: 'Demo' }],
    [project, ['list'], 'project.list', {}],
    [
      task,
      ['create', '--project', 'prj_1', '--title', 'Add login'],
      'task.create',
      { projectId: 'prj_1', title: 'Add login' },
    ],
    [task, ['list', '--project', 'prj_1'], 'task.list', { projectId: 'prj_1' }],
    [
      run,
      ['start', '--task', 'tsk_1', '--agent', 'codex', '--location', 'cloud', '--prompt', 'Do X'],
      'run.start',
      { taskId: 'tsk_1', agent: 'codex', location: 'cloud', prompt: 'Do X' },
    ],
    [
      run,
      ['start', '--task', 'tsk_1', '--agent', 'claude-code', '--prompt', 'Do Y'],
      'run.start',
      { taskId: 'tsk_1', agent: 'claude-code', location: 'local', prompt: 'Do Y' },
    ],
    [run, ['list'], 'run.list', {}],
    [run, ['list', '--task', 'tsk_1'], 'run.list', { taskId: 'tsk_1' }],
    [run, ['get', 'run_1'], 'run.get', { id: 'run_1' }],
    [
      run,
      ['start', '--task', 'tsk_1', '--agent', 'fake', '--prompt', 'P', '--no-pr'],
      'run.start',
      { taskId: 'tsk_1', agent: 'fake', prompt: 'P', openPr: false },
    ],
    [run, ['message', 'run_1', 'also do Z'], 'run.message', { id: 'run_1', text: 'also do Z' }],
    [run, ['cancel', 'run_1'], 'run.cancel', { id: 'run_1' }],
  ] as const)('%#: sf %s → %s', async (cmd, argv, name, body) => {
    const call = await sf(cmd, [...argv]);
    expect(call).toMatchObject({ url: `http://localhost:5173/v1/commands/${name}`, body });
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects an unknown agent before calling the API', async () => {
    await expect(
      runCommand(run, { rawArgs: ['start', '--task', 't', '--agent', 'gpt'] }),
    ).rejects.toThrow(/agent/);
    expect(calls).toHaveLength(0);
  });

  it('honours --api over SF_API_URL, and sends SF_TOKEN as Bearer', async () => {
    vi.stubEnv('SF_API_URL', 'http://env.test');
    vi.stubEnv('SF_TOKEN', 'tok123');
    expect((await sf(project, ['list']))?.url).toBe('http://env.test/v1/commands/project.list');
    const call = await sf(project, ['list', '--api', 'http://flag.test/']);
    expect(call).toMatchObject({
      url: 'http://flag.test/v1/commands/project.list',
      auth: 'Bearer tok123',
    });
  });
});

describe('output', () => {
  it('prints compact tables for lists', async () => {
    await sf(run, ['list']);
    expect(stdout.join('')).toBe(
      'ID     STATE   AGENT  LOCATION  TASK   CREATED\n' +
        'run_1  queued  codex  cloud     tsk_1  2026-10-17 11:15\n',
    );
  });

  it('prints a key/value record for one item', async () => {
    await sf(task, ['create', '--project', 'prj_1', '--title', 'Add login']);
    expect(stdout.join('')).toContain('id       tsk_1\nproject  prj_1\n');
  });

  it('--json prints the raw command output', async () => {
    await sf(run, ['start', '--task', 'tsk_1', '--agent', 'codex', '--prompt', 'p', '--json']);
    expect(JSON.parse(stdout.join(''))).toEqual(run1);
  });

  it('maps API errors to stderr + exit 1, or a JSON error body with --json', async () => {
    await sf(run, ['get', 'nope']);
    expect(stderr.join('')).toBe('error: not_found: run nope\n');
    expect(process.exitCode).toBe(1);
    stdout = [];
    await sf(run, ['get', 'nope', '--json']);
    expect(JSON.parse(stdout.join(''))).toEqual({
      error: { code: 'not_found', message: 'run nope' },
    });
  });

  it('table() handles empty lists and trims trailing padding', () => {
    expect(table([], [['id', (r: { id: string }) => r.id]])).toBe('(none)');
    expect(
      table(
        [{ a: 'x', b: 'long' }],
        [
          ['a', (r) => r.a],
          ['b', (r) => r.b],
        ],
      ),
    ).toBe('A  B\nx  long');
  });
});

describe('watch helpers', () => {
  it('builds ws(s) URLs with ?since', () => {
    expect(eventsUrl('http://localhost:5173', 'run_1')).toBe(
      'ws://localhost:5173/v1/runs/run_1/events',
    );
    expect(eventsUrl('https://sf.dev', 'run_1', 3)).toBe(
      'wss://sf.dev/v1/runs/run_1/events?since=3',
    );
  });

  it('formats events', () => {
    expect(formatEvent({ seq: 1, type: 'run.started', payload: run1, at: NOW })).toBe(
      '   1  11:15:54  run.started   state=queued',
    );
    const f = (type: string, payload: unknown) =>
      formatEvent({ seq: 2, type, payload, at: NOW }).slice(16);
    expect(f('agent', { type: 'message', role: 'assistant', text: 'Hi\nthere' })).toBe(
      'assistant     Hi ⏎ there',
    );
    expect(
      f('agent', { type: 'tool.call', id: 't', name: 'Write', input: { file_path: '/w/a.md' } }),
    ).toBe('tool          → Write /w/a.md');
    expect(
      f('agent', {
        type: 'turn.completed',
        isError: false,
        usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.01 },
      }),
    ).toBe('turn          done $0.0100 3 in / 4 out');
    expect(
      f('diff.snapshot', {
        turn: 1,
        base: 'x',
        patch: '',
        stats: { files: 2, additions: 5, deletions: 1 },
      }),
    ).toBe('diff          turn 1: 2 file(s) +5 -1');
    expect(f('user.message', { id: 'm', text: 'go', author: { userId: 'u' } })).toBe(
      'you           go',
    );
    expect(f('run.state', { from: 'running', to: 'review', run: run1 })).toBe(
      'state         running → review',
    );
    expect(f('pr.opened', { url: 'https://github.com/a/b/pull/1', run: run1 })).toBe(
      'pr            https://github.com/a/b/pull/1',
    );
  });
});

describe('config + login', () => {
  it('resolves the API url: flag > env > default', () => {
    expect(resolveApiUrl(undefined, {})).toBe('http://localhost:5173');
    expect(resolveApiUrl(undefined, { SF_API_URL: 'http://e/' })).toBe('http://e');
    expect(resolveApiUrl('http://f', { SF_API_URL: 'http://e' })).toBe('http://f');
  });

  it('stores the token with mode 0600', async () => {
    const path = join(process.env.SF_CONFIG_DIR!, 'config.json');
    await writeConfig({ token: 't', apiUrl: 'http://x' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ token: 't', apiUrl: 'http://x' });
    expect(await readConfig()).toEqual({ token: 't', apiUrl: 'http://x' });
  });

  it('device flow: requests a code, backs off on slow_down, returns the token', async () => {
    const replies = [
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'sess_tok', token_type: 'Bearer' },
    ];
    const seen: string[] = [];
    const sleeps: number[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${init.body as string}`);
      if (url.endsWith('/device/code'))
        return Response.json({
          device_code: 'dc',
          user_code: 'ABCDEFGH',
          verification_uri: 'http://localhost:5173/device',
          expires_in: 600,
          interval: 5,
        });
      const r = replies.shift()!;
      return Response.json(r, { status: 'error' in r ? 400 : 200 });
    }) as typeof fetch;
    let shown = '';
    const token = await deviceLogin({
      apiUrl: 'http://localhost:5173',
      fetch: f,
      sleep: async (ms) => void sleeps.push(ms),
      onCode: (c) => (shown = c.user_code),
    });
    expect(token).toBe('sess_tok');
    expect(shown).toBe('ABCDEFGH');
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(seen[0]).toBe('http://localhost:5173/api/auth/device/code {"client_id":"sf-cli"}');
    expect(seen[1]).toContain('"grant_type":"urn:ietf:params:oauth:grant-type:device_code"');
  });
});
