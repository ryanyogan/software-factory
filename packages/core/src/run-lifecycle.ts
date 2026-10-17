import {
  CommandError,
  ENDED_RUN_STATES,
  type ProjectNotice,
  type Run,
  type RunState,
  TERMINAL_RUN_STATES,
  transitionActor,
} from '@sf/contract';
import { runs, tasks, type RunRow } from '@sf/db';
import { and, eq } from 'drizzle-orm';
import type { Ctx, EventsPort, RunEventInput } from './context';
import type { Handlers } from './handlers';
import { newId, now, toRun } from './rows';

/*
 * Run lifecycle commands. Authorization model (Phase 1, no project ACLs yet):
 *  - Reads (run.get/list/events) are open to any signed-in user.
 *  - Every mutation of an existing run is OWNER-only (ctx.userId === run.startedBy).
 *  - Daemon-only effects additionally need the claimer machine: input.machineId === run.claimedBy.
 *    Machine ids are self-chosen by the daemon (no registry): they distinguish one owner's machines,
 *    they are not a security boundary between users (the owner check is).
 */

type Loaded = { row: RunRow; projectId: string };

async function loadRun(ctx: Ctx, id: string): Promise<Loaded> {
  const [found] = await ctx.db
    .select({ row: runs, projectId: tasks.projectId })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, id));
  if (!found) throw new CommandError('not_found', `run ${id} not found`);
  return found;
}

function requireOwner(ctx: Ctx, row: RunRow): void {
  if (row.startedBy !== ctx.userId) {
    throw new CommandError('forbidden', `run ${row.id} belongs to another user`);
  }
}

function requireLive(row: RunRow): void {
  if (TERMINAL_RUN_STATES.has(row.state)) {
    throw new CommandError('conflict', `run ${row.id} is ${row.state}`);
  }
}

function requireEvents(ctx: Ctx): EventsPort {
  if (!ctx.events) throw new CommandError('internal', 'no event log configured');
  return ctx.events;
}

async function emit(
  ctx: Ctx,
  loaded: Loaded,
  events: RunEventInput[],
  notices: ProjectNotice[] = [],
): Promise<void> {
  if (!ctx.events) return;
  if (events.length) await ctx.events.append(loaded.row.id, events);
  for (const n of notices) await ctx.events.notifyProject(loaded.projectId, n);
}

/** Events + project notice for a state change. */
function stateChange(from: RunState, to: RunState, run: Run) {
  return {
    event: { type: 'run.state', payload: { from, to, run } } satisfies RunEventInput,
    notice: { type: 'run.state', from, to, run } satisfies ProjectNotice,
  };
}

/**
 * Who may write agent/diff events for a run: its owner's claiming daemon, while the run is live.
 * Shared by `run.append` (HTTP) and the api's RunLog WebSocket writer handshake.
 */
export async function authorizeWriter(
  ctx: Pick<Ctx, 'db' | 'userId'>,
  runId: string,
  machineId: string,
): Promise<Run> {
  const { row } = await loadRun(ctx as Ctx, runId);
  requireOwner(ctx as Ctx, row);
  if (row.claimedBy !== machineId) {
    throw new CommandError('forbidden', `machine ${machineId} has not claimed run ${runId}`);
  }
  requireLive(row);
  return toRun(row);
}

export const runHandlers: Pick<
  Handlers,
  'run.claim' | 'run.update' | 'run.message' | 'run.cancel' | 'run.events' | 'run.append'
> = {
  async 'run.claim'(ctx, input) {
    const loaded = await loadRun(ctx, input.id);
    const { row } = loaded;
    requireOwner(ctx, row);
    // Idempotent retry by the same daemon (e.g. the response was lost).
    if (row.claimedBy === input.machineId && row.state === 'running') return toRun(row);
    if (row.location !== 'local') {
      throw new CommandError('conflict', `run ${row.id} is not a local run`);
    }

    // One conditional statement = atomic in D1/SQLite: exactly one concurrent claim wins.
    const [claimed] = await ctx.db
      .update(runs)
      .set({ state: 'running', claimedBy: input.machineId, claimedAt: now(ctx) })
      .where(and(eq(runs.id, row.id), eq(runs.state, 'queued'), eq(runs.location, 'local')))
      .returning();
    if (!claimed)
      throw new CommandError('conflict', `run ${row.id} is not queued (already claimed?)`);

    const run = toRun(claimed);
    const change = stateChange('queued', 'running', run);
    await emit(
      ctx,
      loaded,
      [{ type: 'run.claimed', payload: { machineId: input.machineId, run } }, change.event],
      [change.notice],
    );
    return run;
  },

  async 'run.update'(ctx, input) {
    const loaded = await loadRun(ctx, input.id);
    const { row } = loaded;
    requireOwner(ctx, row);
    requireLive(row);

    if (input.machineId !== undefined && input.machineId !== row.claimedBy) {
      throw new CommandError(
        'forbidden',
        `machine ${input.machineId} has not claimed run ${row.id}`,
      );
    }
    const isClaimer = input.machineId !== undefined;
    const daemonFields =
      input.sessionId !== undefined ||
      input.costUsd !== undefined ||
      input.prUrl !== undefined ||
      input.endedAt !== undefined;
    if (daemonFields && !isClaimer) {
      throw new CommandError(
        'forbidden',
        'sessionId/costUsd/prUrl/endedAt can only be set by the claiming machine',
      );
    }

    const from = row.state;
    const to = input.state ?? from;
    const set: Partial<RunRow> = {};
    if (to !== from) {
      const actor = transitionActor(from, to);
      if (!actor) throw new CommandError('conflict', `invalid transition ${from} → ${to}`);
      if (actor === 'claimer' && !isClaimer) {
        throw new CommandError('forbidden', `${from} → ${to} is done by the claiming machine`);
      }
      set.state = to;
      if (ENDED_RUN_STATES.has(to)) set.endedAt = now(ctx);
      if (to === 'running') set.endedAt = null;
    }
    if (input.endedAt !== undefined) set.endedAt = new Date(input.endedAt);
    if (input.sessionId !== undefined) set.sessionId = input.sessionId;
    if (input.costUsd !== undefined) set.costUsd = input.costUsd;
    if (input.prUrl !== undefined) set.prUrl = input.prUrl;
    if (Object.keys(set).length === 0) return toRun(row);

    // Optimistic: only apply if nobody changed the state meanwhile.
    const [updated] = await ctx.db
      .update(runs)
      .set(set)
      .where(and(eq(runs.id, row.id), eq(runs.state, from)))
      .returning();
    if (!updated) throw new CommandError('conflict', `run ${row.id} changed concurrently; retry`);

    const run = toRun(updated);
    const events: RunEventInput[] = [];
    const notices: ProjectNotice[] = [];
    if (to !== from) {
      const change = stateChange(from, to, run);
      events.push(change.event);
      notices.push(change.notice);
    }
    if (input.prUrl !== undefined && input.prUrl !== row.prUrl) {
      events.push({ type: 'pr.opened', payload: { url: input.prUrl, run } });
    }
    await emit(ctx, loaded, events, notices);
    return run;
  },

  async 'run.message'(ctx, input) {
    const loaded = await loadRun(ctx, input.id);
    requireOwner(ctx, loaded.row);
    requireLive(loaded.row);
    const events = requireEvents(ctx);
    const message = { id: newId(ctx, 'msg'), text: input.text, author: { userId: ctx.userId } };
    const [event] = await events.append(loaded.row.id, [
      { type: 'user.message', payload: message },
    ]);
    await events.notifyProject(loaded.projectId, {
      type: 'run.message',
      runId: loaded.row.id,
      message,
    });
    return { event: event! };
  },

  async 'run.cancel'(ctx, input) {
    const loaded = await loadRun(ctx, input.id);
    const { row } = loaded;
    requireOwner(ctx, row);
    requireLive(row);

    if (row.state === 'running') {
      // A live agent: ask the daemon (it gets this on the RunLog socket and the project room),
      // which stops the agent and finalizes with run.update → abandoned.
      await emit(
        ctx,
        loaded,
        [{ type: 'run.cancel_requested', payload: { by: ctx.userId } }],
        [{ type: 'run.cancel_requested', runId: row.id, by: ctx.userId }],
      );
      return toRun(row);
    }

    // Nothing is executing (queued/blocked/review/failed/...): abandon right away.
    const [updated] = await ctx.db
      .update(runs)
      .set({ state: 'abandoned', endedAt: now(ctx) })
      .where(and(eq(runs.id, row.id), eq(runs.state, row.state)))
      .returning();
    if (!updated) throw new CommandError('conflict', `run ${row.id} changed concurrently; retry`);
    const run = toRun(updated);
    const change = stateChange(row.state, 'abandoned', run);
    await emit(ctx, loaded, [change.event], [change.notice]);
    return run;
  },

  async 'run.events'(ctx, input) {
    const loaded = await loadRun(ctx, input.id);
    const events = requireEvents(ctx);
    return { events: await events.list(loaded.row.id, input.since, input.limit) };
  },

  async 'run.append'(ctx, input) {
    await authorizeWriter(ctx, input.id, input.machineId);
    const stored = await requireEvents(ctx).append(input.id, input.events);
    return { seqs: stored.map((e) => e.seq) };
  },
};
