/**
 * Transcript view model: RunLog events (stage 8 shapes) → the rows the run page renders.
 * Pure and deterministic so it can be unit tested; the page only maps blocks to components.
 */
import {
  type AgentUsage,
  ENDED_RUN_STATES,
  type Run,
  type RunState,
  TERMINAL_RUN_STATES,
  parseRunEvent,
} from '@sf/contract';
import { type DiffFile, parseUnifiedDiff } from './diff';

/** What the socket / `run.events` deliver (`StoredRunEvent`). */
export interface RawRunEvent {
  seq: number;
  type: string;
  payload: unknown;
  at: number;
  emittedAt?: number;
}

/** Pure merge: dedupe by seq, keep seq order. Returns `prev` unchanged when nothing is new. */
export function mergeEvents(
  prev: readonly RawRunEvent[],
  incoming: readonly RawRunEvent[],
): RawRunEvent[] {
  const seen = new Set(prev.map((e) => e.seq));
  const fresh = incoming.filter((e) => {
    if (seen.has(e.seq)) return false;
    seen.add(e.seq);
    return true;
  });
  if (fresh.length === 0) return prev as RawRunEvent[];
  const last = prev.at(-1)?.seq ?? 0;
  const merged = [...prev, ...fresh];
  // Live frames arrive in order; only sort when something landed out of order.
  return fresh.every((e) => e.seq > last) && isSorted(fresh)
    ? merged
    : merged.sort((a, b) => a.seq - b.seq);
}

const isSorted = (es: readonly RawRunEvent[]) =>
  es.every((e, i) => i === 0 || es[i - 1]!.seq < e.seq);

export type ToolStatus = 'running' | 'done' | 'error';

export type Item =
  | { kind: 'assistant'; key: string; text: string; at: number }
  | { kind: 'reasoning'; key: string; text: string }
  | {
      kind: 'tool';
      key: string;
      toolId: string;
      name: string;
      summary: string;
      input: unknown;
      output?: string;
      truncated?: boolean;
      status: ToolStatus;
    }
  | { kind: 'files'; key: string; changes: { path: string; kind: string }[] }
  | { kind: 'todo'; key: string; items: { text: string; done: boolean }[] }
  | {
      kind: 'user';
      key: string;
      id: string;
      text: string;
      authorId: string;
      at: number;
      /** No agent activity after it yet. */
      pending: boolean;
    }
  | { kind: 'error'; key: string; message: string; fatal: boolean }
  | { kind: 'turn'; key: string; turn: number; usage?: AgentUsage; isError: boolean }
  | {
      kind: 'diff';
      key: string;
      turn: number;
      base: string;
      stats: { files: number; additions: number; deletions: number };
      truncated: boolean;
      files: DiffFile[];
      /** The newest snapshot (the page opens it by default). */
      latest: boolean;
    }
  | { kind: 'state'; key: string; from: RunState; to: RunState }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'pr'; key: string; url: string }
  | { kind: 'raw'; key: string; type: string; payload: unknown };

/** Activity rows that render together inside one `Trace`. */
export type ActivityItem = Extract<Item, { kind: 'reasoning' | 'tool' | 'files' | 'todo' }>;
export type Block =
  | { kind: 'activity'; key: string; items: ActivityItem[] }
  | Exclude<Item, ActivityItem>;

export interface Transcript {
  blocks: Block[];
  /** Number of completed turns. */
  turns: number;
  /** Sum of per-turn `usage.costUsd` deltas in this run's log. */
  costUsd: number | null;
  lastSeq: number;
  /** Session id reported by the agent, if any. */
  sessionId: string | null;
  model: string | null;
}

const isActivity = (i: Item): i is ActivityItem =>
  i.kind === 'reasoning' || i.kind === 'tool' || i.kind === 'files' || i.kind === 'todo';

/** One line for a tool call: the most telling input field, else compact JSON. */
export function toolSummary(input: unknown, max = 100): string {
  let s = '';
  if (typeof input === 'string') s = input;
  else if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const pick = [
      'command',
      'cmd',
      'file_path',
      'path',
      'notebook_path',
      'pattern',
      'url',
      'query',
      'description',
      'prompt',
    ].find((k) => typeof o[k] === 'string' || Array.isArray(o[k]));
    const v = pick ? o[pick] : undefined;
    s = Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : JSON.stringify(o);
  } else if (input !== undefined) s = JSON.stringify(input) ?? '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Show worktree paths relative to the session cwd (agents report absolute paths). */
function relativize(summary: string, cwd: string | null, max = 100): string {
  let s = summary;
  if (cwd) s = s.replaceAll(cwd.endsWith('/') ? cwd : `${cwd}/`, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const STATE_NOTE: Partial<Record<RunState, string>> = {
  review: 'Ready for review',
  failed: 'Run failed',
  abandoned: 'Run cancelled',
  blocked: 'Agent is blocked',
  merged: 'Merged',
};

export function buildTranscript(events: readonly RawRunEvent[], runState?: RunState): Transcript {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  const pendingUsers: Extract<Item, { kind: 'user' }>[] = [];
  let turns = 0;
  let cost: number | null = null;
  let sessionId: string | null = null;
  let model: string | null = null;
  let cwd: string | null = null;
  const diffs: Extract<Item, { kind: 'diff' }>[] = [];
  const seenSeq = new Set<number>();

  for (const raw of sorted) {
    if (seenSeq.has(raw.seq)) continue;
    seenSeq.add(raw.seq);
    const key = String(raw.seq);
    const ev = parseRunEvent(raw);
    if (!ev) {
      items.push({ kind: 'raw', key, type: raw.type, payload: raw.payload });
      continue;
    }
    switch (ev.type) {
      case 'run.started':
        // The prompt is shown in the header; nothing to add.
        break;
      case 'run.claimed':
        items.push({ kind: 'note', key, text: `Claimed by ${ev.payload.machineId}` });
        break;
      case 'run.state': {
        const { from, to } = ev.payload;
        // queued→running is implied by the claim note; resumes (review→running) are worth a line.
        if (!(from === 'queued' && to === 'running')) items.push({ kind: 'state', key, from, to });
        break;
      }
      case 'run.cancel_requested':
        items.push({ kind: 'note', key, text: 'Cancel requested' });
        break;
      case 'pr.opened':
        items.push({ kind: 'pr', key, url: ev.payload.url });
        break;
      case 'user.message': {
        const u: Extract<Item, { kind: 'user' }> = {
          kind: 'user',
          key,
          id: ev.payload.id,
          text: ev.payload.text,
          authorId: ev.payload.author.userId,
          at: ev.at,
          pending: true,
        };
        items.push(u);
        pendingUsers.push(u);
        break;
      }
      case 'diff.snapshot': {
        const d = ev.payload;
        const item: Extract<Item, { kind: 'diff' }> = {
          kind: 'diff',
          key,
          turn: d.turn,
          base: d.base,
          stats: d.stats,
          truncated: d.truncated ?? false,
          files: d.patch ? parseUnifiedDiff(d.patch) : [],
          latest: false,
        };
        diffs.push(item);
        items.push(item);
        break;
      }
      case 'agent': {
        const a = ev.payload;
        // Any agent activity means earlier follow-ups reached the agent.
        if (a.type !== 'session.started') for (const u of pendingUsers.splice(0)) u.pending = false;
        switch (a.type) {
          case 'session.started':
            sessionId = a.sessionId;
            model = a.model ?? model;
            cwd = a.cwd ?? cwd;
            break;
          case 'message':
            // Adapters echo user text only in edge cases; follow-ups come from `user.message`.
            if (a.role === 'assistant' && a.text.trim())
              items.push({ kind: 'assistant', key, text: a.text, at: ev.at });
            break;
          case 'reasoning':
            if (a.text.trim()) items.push({ kind: 'reasoning', key, text: a.text });
            break;
          case 'tool.call': {
            const t: Extract<Item, { kind: 'tool' }> = {
              kind: 'tool',
              key,
              toolId: a.id,
              name: a.name,
              summary: relativize(toolSummary(a.input, 400), cwd),
              input: a.input,
              status: 'running',
            };
            tools.set(a.id, t);
            items.push(t);
            break;
          }
          case 'tool.result': {
            const t = tools.get(a.id);
            if (t) {
              t.output = a.output;
              t.truncated = a.truncated;
              t.status = a.isError ? 'error' : 'done';
            } else {
              items.push({
                kind: 'tool',
                key,
                toolId: a.id,
                name: 'tool',
                summary: '',
                input: undefined,
                output: a.output,
                truncated: a.truncated,
                status: a.isError ? 'error' : 'done',
              });
            }
            break;
          }
          case 'file.change':
            items.push({ kind: 'files', key, changes: a.changes });
            break;
          case 'todo':
            items.push({ kind: 'todo', key, items: a.items });
            break;
          case 'turn.completed': {
            turns++;
            if (a.usage?.costUsd !== undefined) cost = (cost ?? 0) + a.usage.costUsd;
            // Tools still "running" at a turn boundary never got a result.
            for (const t of tools.values()) if (t.status === 'running') t.status = 'done';
            items.push({ kind: 'turn', key, turn: turns, usage: a.usage, isError: a.isError });
            break;
          }
          case 'error':
            items.push({ kind: 'error', key, message: a.message, fatal: a.fatal });
            break;
        }
        break;
      }
    }
  }

  // A run that ended can't have running tools.
  if (runState && runState !== 'running')
    for (const t of tools.values()) if (t.status === 'running') t.status = 'done';
  const last = diffs.at(-1);
  if (last) last.latest = true;

  const blocks: Block[] = [];
  for (const item of items) {
    if (isActivity(item)) {
      const prev = blocks.at(-1);
      if (prev?.kind === 'activity') prev.items.push(item);
      else blocks.push({ kind: 'activity', key: `a${item.key}`, items: [item] });
    } else blocks.push(item);
  }

  return {
    blocks,
    turns,
    costUsd: cost,
    lastSeq: sorted.at(-1)?.seq ?? 0,
    sessionId,
    model,
  };
}

export function stateNote(state: RunState): string {
  return STATE_NOTE[state] ?? state.replace('_', ' ');
}

/** Why the follow-up box is disabled, or null when `run.message` will be accepted. */
export function messageBlockedReason(run: Pick<Run, 'state' | 'location'>): string | null {
  if (TERMINAL_RUN_STATES.has(run.state))
    return `This run is ${run.state}; start a new run to continue.`;
  if (run.location === 'cloud') return 'Cloud runs are not available yet.';
  return null;
}

/** Cancel is offered while the run is live (queued, running, blocked); ended runs are abandoned instead. */
export function canCancel(run: Pick<Run, 'state'>): boolean {
  return !ENDED_RUN_STATES.has(run.state) && !TERMINAL_RUN_STATES.has(run.state);
}

/** Short reason a run needs a human (Needs you / task page). */
export function needsYouReason(run: Pick<Run, 'state' | 'location' | 'prUrl'>): string {
  switch (run.state) {
    case 'queued':
      return run.location === 'local'
        ? 'Waiting for a daemon (sf daemon)'
        : 'Waiting: cloud runs are not available yet';
    case 'blocked':
      return 'Agent is blocked';
    case 'review':
      return run.prUrl ? 'Ready for review (PR open)' : 'Ready for review';
    case 'failed':
      return 'Failed: check the transcript';
    default:
      return stateNote(run.state);
  }
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  return usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
