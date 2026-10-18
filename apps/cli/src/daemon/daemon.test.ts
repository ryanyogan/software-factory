import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startAgent } from '@sf/adapters';
import type { FakeScriptInput } from '@sf/adapters/fake';
import type { Run, Task } from '@sf/contract';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { git } from '../git';
import { createFakePrProvider, type FakePrProvider } from '../pr';
import { makeRepo, tempDir } from '../test-repo';
import { Daemon } from './daemon';
import { createHub, type Hub } from './testing';
import { worktreePath } from './worker';

const fast = { minBackoffMs: 5, maxBackoffMs: 20, stableMs: 50, pingMs: 1000, pongTimeoutMs: 500 };

async function waitFor<T>(
  fn: () => T | Promise<T>,
  what: string,
  ms = 8000,
): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Turn 1 writes a file, then pauses so a follow-up can arrive mid-run. */
const script: FakeScriptInput = {
  turns: [
    {
      steps: [
        { type: 'message', text: 'Working on: {{prompt}}' },
        { type: 'write', path: 'login.md', content: '# Login\n\n{{prompt}}\n' },
        { type: 'sleep', ms: 300 },
        { type: 'message', text: 'Done with turn 1.' },
      ],
    },
  ],
  followUp: {
    steps: [
      { type: 'message', text: 'Follow-up received: {{prompt}}' },
      { type: 'write', path: 'turn-{{turn}}.md', content: '{{prompt}}\n' },
    ],
  },
};

interface Setup {
  hub: Hub;
  repo: string;
  dataDir: string;
  task: Task;
  pr: FakePrProvider;
  daemons: Daemon[];
  logs: string[];
  daemon(machineId?: string, s?: FakeScriptInput): Promise<Daemon>;
  start(prompt?: string): Promise<Run>;
  types(runId: string): string[];
  agentTypes(runId: string): string[];
  run(runId: string): Promise<Run>;
}

const live: Setup[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) for (const d of s.daemons) await d.stop(2000);
});

async function setup(): Promise<Setup> {
  const hub = await createHub('dev');
  const repo = await makeRepo({ remote: 'git@github.com:acme/web.git' });
  const dataDir = await tempDir('sf-data-');
  const project = await hub.client.call('project.create', {
    name: 'Web',
    repoUrl: 'https://github.com/acme/web',
  });
  const task = await hub.client.call('task.create', { projectId: project.id, title: 'Add login' });
  const pr = createFakePrProvider();
  const logs: string[] = [];
  const s: Setup = {
    hub,
    repo,
    dataDir,
    task,
    pr,
    logs,
    daemons: [],
    async daemon(machineId = 'mch_a', sc = script) {
      const d = new Daemon({
        transport: hub.transport(machineId),
        machineId,
        dataDir,
        prProvider: pr,
        startAgent,
        agentEnv: { ...process.env, SF_FAKE_SCRIPT: JSON.stringify(sc) },
        projects: new Map([[project.id, repo]]),
        log: (m) => logs.push(`${machineId} ${m}`),
        timings: fast,
      });
      s.daemons.push(d);
      await d.start();
      return d;
    },
    start: (prompt = 'add a login page') =>
      hub.client.call('run.start', { taskId: task.id, agent: 'fake', prompt }),
    types: (runId) => hub.events(runId).map((e) => e.type),
    agentTypes: (runId) =>
      hub
        .events(runId)
        .filter((e) => e.type === 'agent')
        .map((e) => (e.payload as { type: string }).type),
    run: (id) => hub.client.call('run.get', { id }),
  };
  live.push(s);
  return s;
}

describe('sf daemon (fake agent, in-memory API)', () => {
  it('claims → streams events → diff → follow-up → commits → PR → review', async () => {
    const s = await setup();
    await s.daemon();
    const run = await s.start();

    // The follow-up arrives while turn 1 is still running (fake: queued as turn 2).
    await waitFor(() => s.agentTypes(run.id).includes('file.change'), 'turn 1 write');
    await s.hub.client.call('run.message', { id: run.id, text: 'also add a logout link' });

    const done = await waitFor(async () => {
      const r = await s.run(run.id);
      return r.state === 'review' ? r : undefined;
    }, 'review');

    expect(done).toMatchObject({ claimedBy: 'mch_a', costUsd: 0.02 });
    expect(done.sessionId).toMatch(/^fake-/);
    expect(done.prUrl).toBe('https://github.com/acme/web/pull/1');
    const types = s.types(run.id);
    expect(types.slice(0, 3)).toEqual(['run.started', 'run.claimed', 'run.state']);
    expect(types).toContain('user.message');
    expect(types).toContain('pr.opened');
    expect(types.slice(-2)).toEqual(['run.state', 'pr.opened']);
    expect(s.agentTypes(run.id).filter((t) => t === 'turn.completed')).toHaveLength(2);

    const diffs = s.hub.events(run.id).filter((e) => e.type === 'diff.snapshot');
    expect(diffs.map((d) => (d.payload as { turn: number }).turn)).toEqual([1, 2]);
    const last = diffs.at(-1)!.payload as { patch: string; stats: { files: number } };
    expect(last.stats.files).toBe(2);
    expect(last.patch).toContain('+also add a logout link');
    expect(diffs[0]!.emittedAt).toEqual(expect.any(Number));

    // Commit on the task branch, in the task worktree; the main checkout is untouched.
    const wt = worktreePath(s.dataDir, s.task.projectId, s.task.id);
    expect(await git(s.repo, ['log', '-1', '--format=%B', s.task.branch])).toContain(
      `Add login\n\nsf run ${run.id}`,
    );
    expect(await readFile(join(wt, 'login.md'), 'utf8')).toContain('add a login page');
    expect(await git(s.repo, ['status', '--porcelain'])).toBe('');
    expect(s.pr.opened[0]).toMatchObject({
      branch: s.task.branch,
      base: 'main',
      title: 'Add login',
    });
    // Events went over the WebSocket, not the HTTP fallback.
    expect(s.hub.stats.wsFrames).toBeGreaterThan(0);
    expect(s.hub.stats.httpAppends).toBe(0);
  });

  it('resumes a run in review when a follow-up arrives, in the same session', async () => {
    const s = await setup();
    const d = await s.daemon('mch_a', {
      // A resumed fake session starts again at turn 1, so write something prompt-dependent.
      turns: [{ steps: [{ type: 'write', path: 'a.md', content: '{{prompt}}\n' }] }],
    });
    const run = await s.start();
    const first = await waitFor(async () => {
      const r = await s.run(run.id);
      return r.state === 'review' ? r : undefined;
    }, 'first review');
    await d.idle();

    await s.hub.client.call('run.message', { id: run.id, text: 'now b' });
    await waitFor(() => d.stats.resumed === 1, 'resume');
    const second = await waitFor(async () => {
      const r = await s.run(run.id);
      return r.state === 'review' && r.endedAt !== first.endedAt ? r : undefined;
    }, 'second review');
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.costUsd).toBe(0.02);
    const turns = s.hub
      .events(run.id)
      .filter((e) => e.type === 'diff.snapshot')
      .map((e) => (e.payload as { turn: number }).turn);
    expect(turns).toEqual([1, 2]);
    expect(await git(s.repo, ['rev-list', '--count', `main..${s.task.branch}`])).toBe('2');
  });

  it('picks up a follow-up sent while the daemon was offline when it starts again', async () => {
    const s = await setup();
    const sc: FakeScriptInput = {
      turns: [{ steps: [{ type: 'write', path: 'a.md', content: '{{prompt}}\n' }] }],
    };
    const d = await s.daemon('mch_a', sc);
    const run = await s.start();
    await waitFor(async () => (await s.run(run.id)).state === 'review', 'first review');
    await d.idle();
    await d.stop(2000);

    // No daemon is listening: the message is only in the log.
    await s.hub.client.call('run.message', { id: run.id, text: 'offline follow-up' });
    await new Promise((r) => setTimeout(r, 50));
    expect((await s.run(run.id)).state).toBe('review');

    const d2 = await s.daemon('mch_a', sc);
    await waitFor(() => d2.stats.resumed === 1, 'resume on startup');
    await waitFor(async () => {
      const turns = s.hub.events(run.id).filter((e) => e.type === 'diff.snapshot');
      return turns.length === 2 && (await s.run(run.id)).state === 'review';
    }, 'second review');
    const last = s.hub.events(run.id).findLast((e) => e.type === 'diff.snapshot')!;
    expect((last.payload as { patch: string }).patch).toContain('+offline follow-up');

    // A restart with nothing new does not resume again.
    await d2.idle();
    await d2.stop(2000);
    const d3 = await s.daemon('mch_a', sc);
    await d3.idle();
    expect(d3.stats.resumed).toBe(0);
  });

  it('cancels a running agent → abandoned', async () => {
    const s = await setup();
    await s.daemon('mch_a', { turns: [{ steps: [{ type: 'sleep', ms: 5000 }] }] });
    const run = await s.start();
    await waitFor(() => s.agentTypes(run.id).includes('session.started'), 'agent start');
    const r = await s.hub.client.call('run.cancel', { id: run.id });
    expect(r.state).toBe('running'); // the daemon finalizes
    const final = await waitFor(async () => {
      const x = await s.run(run.id);
      return x.state === 'abandoned' ? x : undefined;
    }, 'abandoned');
    expect(final.prUrl).toBeNull();
    expect(s.types(run.id)).toContain('run.cancel_requested');
    expect(s.pr.opened).toHaveLength(0);
  });

  it('second daemon gets 409 and moves on; one run per task at a time', async () => {
    const s = await setup();
    const a = await s.daemon('mch_a', { turns: [{ steps: [{ type: 'sleep', ms: 200 }] }] });
    const b = await s.daemon('mch_b', { turns: [{ steps: [{ type: 'sleep', ms: 200 }] }] });
    const r1 = await s.start('one');
    const r2 = await s.start('two');
    await waitFor(async () => {
      const [x, y] = await Promise.all([s.run(r1.id), s.run(r2.id)]);
      return x.state === 'review' && y.state === 'review';
    }, 'both reviewed');
    await Promise.all([a.idle(), b.idle()]);
    // Each run was claimed exactly once; the losing claims were 409s, not errors.
    expect(a.stats.claimed + b.stats.claimed).toBe(2);
    expect(a.stats.conflicts + b.stats.conflicts).toBeGreaterThan(0);
    expect(s.logs.some((l) => l.includes('already claimed elsewhere (409)'))).toBe(true);
    // Same task, two daemons: runs never overlapped on one machine (one per task).
    expect(s.logs.filter((l) => l.includes('claim failed'))).toEqual([]);
  });

  it('marks its running runs failed on shutdown, and recovers stale ones on start', async () => {
    const s = await setup();
    const d = await s.daemon('mch_a', { turns: [{ steps: [{ type: 'sleep', ms: 5000 }] }] });
    const run = await s.start();
    await waitFor(() => s.agentTypes(run.id).includes('session.started'), 'agent start');
    await d.stop();
    const r = await s.run(run.id);
    expect(r.state).toBe('failed');
    expect(s.agentTypes(run.id)).toContain('error');

    // A run left `running` by this machine (e.g. kill -9) is failed by the next daemon.
    const stale = await s.start('stale');
    await s.hub.client.call('run.claim', { id: stale.id, machineId: 'mch_a' });
    await s.daemon('mch_a');
    await waitFor(async () => (await s.run(stale.id)).state === 'failed', 'stale → failed');
  });

  it('falls back to HTTP run.append while the socket is down', async () => {
    const s = await setup();
    await s.daemon('mch_a', {
      stepDelayMs: 30,
      turns: [{ steps: [{ type: 'burst', count: 20, intervalMs: 10, text: 'm{{i}}' }] }],
    });
    const run = await s.start();
    await waitFor(() => s.agentTypes(run.id).filter((t) => t === 'message').length >= 2, 'msgs');
    s.hub.offline = true;
    s.hub.dropAll();
    await new Promise((r) => setTimeout(r, 80));
    s.hub.offline = false;
    await waitFor(async () => (await s.run(run.id)).state === 'review', 'review');
    expect(s.hub.stats.httpAppends).toBeGreaterThan(0);
    const texts = s.hub
      .events(run.id)
      .filter((e) => e.type === 'agent' && (e.payload as { type: string }).type === 'message')
      .map((e) => (e.payload as { text: string }).text);
    // Every message exactly once, in order, despite resends.
    expect(texts).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 1}`));
  });
});
