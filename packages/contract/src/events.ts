import { z } from 'zod';
import { HttpUrl, Id, MachineId, Run, RunState } from './schemas';

/* ------------------------------------------------------------------------------------------------
 * AgentEvent: the one normalized shape every adapter (claude-code, codex, fake) emits.
 * Mapping from each SDK: .handoff/phase1-research.md §3.
 * ---------------------------------------------------------------------------------------------- */

/** Max chars of a tool result the daemon should send; longer output is cut and `truncated: true`. */
export const TOOL_OUTPUT_MAX = 16 * 1024;
/** Max chars of a diff snapshot patch; bigger diffs send stats only with `truncated: true`. */
export const DIFF_PATCH_MAX = 1024 * 1024;

export const AgentUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  /** Cost of THIS turn in USD (adapters difference cumulative SDK totals). */
  costUsd: z.number().nonnegative().optional(),
});
export type AgentUsage = z.infer<typeof AgentUsage>;

export const AgentEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.started'),
    sessionId: z.string().min(1),
    model: z.string().optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('message'),
    role: z.enum(['assistant', 'user']),
    text: z.string(),
    itemId: z.string().optional(),
  }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({
    type: z.literal('tool.call'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool.result'),
    id: z.string().min(1),
    output: z.string().max(TOOL_OUTPUT_MAX),
    isError: z.boolean(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('file.change'),
    changes: z.array(z.object({ path: z.string(), kind: z.enum(['add', 'delete', 'update']) })),
  }),
  z.object({
    type: z.literal('todo'),
    items: z.array(z.object({ text: z.string(), done: z.boolean() })),
  }),
  z.object({
    type: z.literal('turn.completed'),
    usage: AgentUsage.optional(),
    isError: z.boolean().default(false),
    result: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean().default(false) }),
]);
export type AgentEvent = z.output<typeof AgentEvent>;
export type AgentEventInput = z.input<typeof AgentEvent>;

/* ------------------------------------------------------------------------------------------------
 * RunEvent: the RunLog envelope `{ seq, type, payload, at }`. Agent events are wrapped as
 * `{ type: 'agent', payload: AgentEvent }`; everything else is a daemon/system event.
 * ---------------------------------------------------------------------------------------------- */

export const DiffStats = z.object({
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export const DiffSnapshot = z.object({
  /** 1-based agent turn this snapshot follows. */
  turn: z.number().int().positive(),
  /** Base commit sha the diff is against. */
  base: z.string().min(1),
  /** Unified diff (incl. untracked files); '' when truncated. */
  patch: z.string().max(DIFF_PATCH_MAX),
  stats: DiffStats,
  truncated: z.boolean().optional(),
});
export type DiffSnapshot = z.infer<typeof DiffSnapshot>;

export const UserMessage = z.object({
  /** `msg_…`, so a daemon can dedupe deliveries. */
  id: Id,
  text: z.string().min(1).max(100_000),
  author: z.object({ userId: Id }),
});
export type UserMessage = z.infer<typeof UserMessage>;

export const RunStateChange = z.object({ from: RunState, to: RunState, run: Run });
export type RunStateChange = z.infer<typeof RunStateChange>;

/** Every event type with its payload. `run.*`/`user.message`/`pr.opened` are written by core only. */
export const runEventPayloads = {
  'run.started': Run,
  'run.claimed': z.object({ machineId: MachineId, run: Run }),
  'run.state': RunStateChange,
  agent: AgentEvent,
  'diff.snapshot': DiffSnapshot,
  'user.message': UserMessage,
  'run.cancel_requested': z.object({ by: Id }),
  'pr.opened': z.object({ url: HttpUrl, run: Run }),
} as const;
export type RunEventType = keyof typeof runEventPayloads;
export const runEventTypes = Object.keys(runEventPayloads) as RunEventType[];

const envelope = {
  seq: z.number().int().positive(),
  /** ms since epoch, stamped by the RunLog on append. */
  at: z.number().int(),
  /** ms since epoch, stamped by the daemon right before sending (latency measurement). */
  emittedAt: z.number().optional(),
};

const typed = <T extends RunEventType>(type: T) =>
  z.object({ ...envelope, type: z.literal(type), payload: runEventPayloads[type] });

/** A typed, stored run event. Use `parseRunEvent` on wire data (legacy rows may not match). */
export const RunEvent = z.discriminatedUnion('type', [
  typed('run.started'),
  typed('run.claimed'),
  typed('run.state'),
  typed('agent'),
  typed('diff.snapshot'),
  typed('user.message'),
  typed('run.cancel_requested'),
  typed('pr.opened'),
]);
export type RunEvent = z.output<typeof RunEvent>;

/** Loose envelope: what RunLog stores/returns (`run.events` output). Tolerates legacy/unknown types. */
export const StoredRunEvent = z.object({
  ...envelope,
  type: z.string().min(1),
  payload: z.unknown(),
});
export type StoredRunEvent = z.infer<typeof StoredRunEvent>;

/** Typed view of a stored event, or null if its type/payload is unknown (e.g. Phase 0 rows). */
export function parseRunEvent(raw: unknown): RunEvent | null {
  const r = RunEvent.safeParse(raw);
  return r.success ? r.data : null;
}

/* ------------------------------------------------------------------------------------------------
 * What a daemon (the run's claimer) may append: only agent events and diff snapshots.
 * State, PR and follow-ups go through commands (run.update / run.message) so every surface agrees.
 * ---------------------------------------------------------------------------------------------- */

const daemonCommon = {
  emittedAt: z.number().optional(),
  /** Idempotency key (e.g. `<machineId>:<counter>`): a resend with the same key is not re-appended. */
  key: z.string().min(1).max(200).optional(),
};

export const DaemonEventInput = z.discriminatedUnion('type', [
  z.object({ ...daemonCommon, type: z.literal('agent'), payload: AgentEvent }),
  z.object({ ...daemonCommon, type: z.literal('diff.snapshot'), payload: DiffSnapshot }),
]);
export type DaemonEventInput = z.input<typeof DaemonEventInput>;
export type DaemonEvent = z.output<typeof DaemonEventInput>;

/** Max events per batch (WS frame or `run.append`). */
export const EVENT_BATCH_MAX = 500;
export const DaemonEventBatch = z.array(DaemonEventInput).min(1).max(EVENT_BATCH_MAX);

/* ------------------------------------------------------------------------------------------------
 * WebSocket frames.
 * RunLog  `GET /v1/runs/:id/events?since=<seq>`  — server→client: StoredRunEvent JSON per frame,
 *   or a control frame below. Writers (claimer daemon, header `x-sf-machine`) may send RunLogClientFrame.
 * ProjectRoom `GET /v1/projects/:id/room` — server→client: ProjectNotice JSON per frame.
 * Text `ping` → `pong` on both (auto-response; does not wake the DO).
 * ---------------------------------------------------------------------------------------------- */

export const RunLogClientFrame = z.object({ type: z.literal('append'), events: DaemonEventBatch });
export type RunLogClientFrame = z.input<typeof RunLogClientFrame>;

export const RunLogServerFrame = z.discriminatedUnion('type', [
  /** Reply to an `append` frame: seqs in input order (a deduped key returns the original seq). */
  z.object({ type: z.literal('ack'), seqs: z.array(z.number().int()) }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type RunLogServerFrame = z.infer<typeof RunLogServerFrame>;

/** Broadcast by ProjectRoom to every socket in the room (daemons learn of work without polling). */
export const ProjectNotice = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.queued'), run: Run }),
  z.object({ type: z.literal('run.state'), from: RunState, to: RunState, run: Run }),
  z.object({ type: z.literal('run.message'), runId: Id, message: UserMessage }),
  z.object({ type: z.literal('run.cancel_requested'), runId: Id, by: Id }),
]);
export type ProjectNotice = z.infer<typeof ProjectNotice>;
