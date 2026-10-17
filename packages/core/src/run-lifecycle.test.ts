import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { type Run, runTransitions, RunState } from '@sf/contract';
import { runs, schema } from '@sf/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from './context';
import { dispatch } from './dispatch';
import { createMemoryEvents, type MemoryEvents } from './memory-events';
import { authorizeWriter } from './run-lifecycle';

const migrationsFolder = fileURLToPath(new URL('../../db/drizzle', import.meta.url));
const M1 = 'mch_laptop';
const M2 = 'mch_desktop';

let owner: Ctx;
let other: Ctx;
let events: MemoryEvents;
let projectId: string;
let taskId: string;

beforeEach(async () => {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder });
  events = createMemoryEvents(() => 1000);
  owner = { db, userId: 'user_1', events };
  other = { db, userId: 'user_2', events };
  const project = await dispatch(owner, 'project.create', { name: 'P' });
  const task = await dispatch(owner, 'task.create', { projectId: project.id, title: 'T' });
  projectId = project.id;
  taskId = task.id;
});

const start = (location: 'local' | 'cloud' = 'local') =>
  dispatch(owner, 'run.start', { taskId, agent: 'codex', prompt: 'do it', location });

async function claimed(): Promise<Run> {
  const run = await start();
  return dispatch(owner, 'run.claim', { id: run.id, machineId: M1 });
}

const eqId = (id: string) => eq(runs.id, id);
const types = (runId: string) => (events.runs.get(runId) ?? []).map((e) => e.type);

describe('run.claim', () => {
  it('moves a queued local run to running and records the machine', async () => {
    const run = await start();
    const out = await dispatch(owner, 'run.claim', { id: run.id, machineId: M1 });
    expect(out).toMatchObject({ state: 'running', claimedBy: M1, claimedAt: expect.any(String) });
    expect(types(run.id)).toEqual(['run.started', 'run.claimed', 'run.state']);
    expect(events.runs.get(run.id)![2]!.payload).toMatchObject({ from: 'queued', to: 'running' });
    expect(events.notices.at(-1)).toMatchObject({
      projectId,
      notice: { type: 'run.state', from: 'queued', to: 'running' },
    });
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const run = await start();
    const results = await Promise.allSettled([
      dispatch(owner, 'run.claim', { id: run.id, machineId: M1 }),
      dispatch(owner, 'run.claim', { id: run.id, machineId: M2 }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'conflict',
      status: 409,
    });
    const final = await dispatch(owner, 'run.get', { id: run.id });
    expect(final.claimedBy).toBe((won[0] as PromiseFulfilledResult<Run>).value.claimedBy);
  });

  it('is idempotent for the same machine, 409 for another', async () => {
    const run = await claimed();
    expect(await dispatch(owner, 'run.claim', { id: run.id, machineId: M1 })).toEqual(run);
    await expect(dispatch(owner, 'run.claim', { id: run.id, machineId: M2 })).rejects.toMatchObject(
      { code: 'conflict' },
    );
  });

  it('rejects cloud runs, other users, unknown runs and bad machine ids', async () => {
    const cloud = await start('cloud');
    await expect(
      dispatch(owner, 'run.claim', { id: cloud.id, machineId: M1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const run = await start();
    await expect(dispatch(other, 'run.claim', { id: run.id, machineId: M1 })).rejects.toMatchObject(
      {
        code: 'forbidden',
        status: 403,
      },
    );
    await expect(dispatch(owner, 'run.claim', { id: 'nope', machineId: M1 })).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
    await expect(
      dispatch(owner, 'run.claim', { id: run.id, machineId: 'has space' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('run.update', () => {
  it('lets the claimer record session/cost and finish in review (endedAt stamped)', async () => {
    const run = await claimed();
    const mid = await dispatch(owner, 'run.update', {
      id: run.id,
      machineId: M1,
      sessionId: 'sess_1',
      costUsd: 0.12,
    });
    expect(mid).toMatchObject({ state: 'running', sessionId: 'sess_1', costUsd: 0.12 });
    const done = await dispatch(owner, 'run.update', {
      id: run.id,
      machineId: M1,
      state: 'review',
      prUrl: 'https://github.com/acme/p/pull/1',
    });
    expect(done).toMatchObject({ state: 'review', prUrl: 'https://github.com/acme/p/pull/1' });
    expect(done.endedAt).not.toBeNull();
    expect(types(run.id).slice(-2)).toEqual(['run.state', 'pr.opened']);

    // owner (no machine) merges from any surface
    const merged = await dispatch(owner, 'run.update', { id: run.id, state: 'merged' });
    expect(merged.state).toBe('merged');
    await expect(
      dispatch(owner, 'run.update', { id: run.id, state: 'abandoned' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('clears endedAt when a follow-up resumes a reviewed run', async () => {
    const run = await claimed();
    await dispatch(owner, 'run.update', { id: run.id, machineId: M1, state: 'review' });
    const resumed = await dispatch(owner, 'run.update', {
      id: run.id,
      machineId: M1,
      state: 'running',
    });
    expect(resumed).toMatchObject({ state: 'running', endedAt: null });
  });

  it('enforces claimer vs owner', async () => {
    const run = await claimed();
    // owner without machine id cannot do a claimer transition or set daemon fields
    await expect(
      dispatch(owner, 'run.update', { id: run.id, state: 'review' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      dispatch(owner, 'run.update', { id: run.id, sessionId: 's' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // another machine of the same owner
    await expect(
      dispatch(owner, 'run.update', { id: run.id, machineId: M2, state: 'review' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // another user, even with the right machine id
    await expect(
      dispatch(other, 'run.update', { id: run.id, machineId: M1, state: 'review' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // owner escape hatch: abandon a running run (dead daemon)
    expect((await dispatch(owner, 'run.update', { id: run.id, state: 'abandoned' })).state).toBe(
      'abandoned',
    );
  });

  it('rejects transitions outside the table (queued → running only via claim)', async () => {
    const run = await start();
    await expect(
      dispatch(owner, 'run.update', { id: run.id, machineId: undefined, state: 'running' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      dispatch(owner, 'run.update', { id: run.id, state: 'merged' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('follows the transition table exactly', async () => {
    // For every (from, to) pair: put a claimed run into `from` directly, then try as claimer.
    const expected: string[] = [];
    const actual: string[] = [];
    for (const from of RunState.options) {
      for (const to of RunState.options) {
        if (from === to) continue;
        const run = await claimed();
        await owner.db.update(runs).set({ state: from }).where(eqId(run.id));
        const allowed = runTransitions[from][to] !== undefined;
        expected.push(`${from}→${to}:${allowed ? to : 'conflict'}`);
        const outcome = await dispatch(owner, 'run.update', {
          id: run.id,
          machineId: M1,
          state: to,
        }).then(
          (r) => r.state,
          (e: { code: string }) => e.code,
        );
        actual.push(`${from}→${to}:${outcome}`);
      }
    }
    expect(actual).toEqual(expected);
  });
});

describe('run.message', () => {
  it('appends a user.message and notifies the project room', async () => {
    const run = await claimed();
    const { event } = await dispatch(owner, 'run.message', { id: run.id, text: 'also add tests' });
    expect(event).toMatchObject({
      type: 'user.message',
      payload: {
        text: 'also add tests',
        author: { userId: 'user_1' },
        id: expect.stringMatching(/^msg_/),
      },
    });
    expect(events.notices.at(-1)!.notice).toMatchObject({ type: 'run.message', runId: run.id });
    await expect(dispatch(other, 'run.message', { id: run.id, text: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(dispatch(owner, 'run.message', { id: run.id, text: '' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('is refused on terminal runs and without an event log', async () => {
    const run = await start();
    await dispatch(owner, 'run.cancel', { id: run.id });
    await expect(dispatch(owner, 'run.message', { id: run.id, text: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    });
    const live = await start();
    await expect(
      dispatch({ ...owner, events: undefined }, 'run.message', { id: live.id, text: 'x' }),
    ).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('run.cancel', () => {
  it('abandons a queued run immediately', async () => {
    const run = await start();
    const out = await dispatch(owner, 'run.cancel', { id: run.id });
    expect(out).toMatchObject({ state: 'abandoned', endedAt: expect.any(String) });
    expect(types(run.id)).toEqual(['run.started', 'run.state']);
  });

  it('only requests cancel on a running run; the daemon finalizes', async () => {
    const run = await claimed();
    const out = await dispatch(owner, 'run.cancel', { id: run.id });
    expect(out.state).toBe('running');
    expect(types(run.id).at(-1)).toBe('run.cancel_requested');
    expect(events.notices.at(-1)!.notice).toEqual({
      type: 'run.cancel_requested',
      runId: run.id,
      by: 'user_1',
    });
    const fin = await dispatch(owner, 'run.update', {
      id: run.id,
      machineId: M1,
      state: 'abandoned',
    });
    expect(fin.state).toBe('abandoned');
    await expect(dispatch(owner, 'run.cancel', { id: run.id })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('is owner-only', async () => {
    const run = await start();
    await expect(dispatch(other, 'run.cancel', { id: run.id })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('run.events / run.append', () => {
  const agentMsg = (text: string, key?: string) => ({
    type: 'agent' as const,
    payload: { type: 'message' as const, role: 'assistant' as const, text },
    emittedAt: 5,
    key,
  });

  it('appends daemon events (deduped by key) and lists since a seq', async () => {
    const run = await claimed(); // seqs 1-3
    const a = await dispatch(owner, 'run.append', {
      id: run.id,
      machineId: M1,
      events: [
        agentMsg('hi', 'k1'),
        {
          type: 'diff.snapshot',
          payload: {
            turn: 1,
            base: 'abc',
            patch: '',
            stats: { files: 0, additions: 0, deletions: 0 },
          },
        },
      ],
    });
    expect(a.seqs).toEqual([4, 5]);
    const again = await dispatch(owner, 'run.append', {
      id: run.id,
      machineId: M1,
      events: [agentMsg('hi', 'k1'), agentMsg('more')],
    });
    expect(again.seqs).toEqual([4, 6]);

    const { events: listed } = await dispatch(other, 'run.events', { id: run.id, since: 3 });
    expect(listed.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(listed[0]).toMatchObject({ type: 'agent', emittedAt: 5, payload: { text: 'hi' } });
    expect(
      (await dispatch(owner, 'run.events', { id: run.id, since: 0, limit: 2 })).events,
    ).toHaveLength(2);
  });

  it('only accepts agent/diff events from the claiming machine of the owner', async () => {
    const run = await claimed();
    const forged = {
      type: 'user.message',
      payload: { id: 'm', text: 'x', author: { userId: 'u' } },
    };
    await expect(
      dispatch(owner, 'run.append', { id: run.id, machineId: M1, events: [forged] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      dispatch(owner, 'run.append', { id: run.id, machineId: M2, events: [agentMsg('x')] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      dispatch(other, 'run.append', { id: run.id, machineId: M1, events: [agentMsg('x')] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(authorizeWriter(owner, run.id, M1)).resolves.toMatchObject({ id: run.id });
    await dispatch(owner, 'run.update', { id: run.id, state: 'abandoned' });
    await expect(authorizeWriter(owner, run.id, M1)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('404s for unknown runs', async () => {
    await expect(dispatch(owner, 'run.events', { id: 'nope' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('legacy rows', () => {
  it('reads a Phase 0 run (no prompt column values) with defaults', async () => {
    await owner.db.insert(runs).values({
      id: 'run_old',
      taskId,
      agent: 'codex',
      location: 'local',
      startedBy: 'user_1',
      createdAt: new Date(0),
    });
    expect(await dispatch(owner, 'run.get', { id: 'run_old' })).toMatchObject({
      prompt: '',
      openPr: true,
      state: 'queued',
      claimedBy: null,
    });
  });
});
