/** Pure helpers for `sf watch` (unit-tested). */
export interface RunEventMessage {
  seq: number;
  type: string;
  payload: unknown;
  at: string | number;
}

export function eventsUrl(apiUrl: string, runId: string, since = 0): string {
  const u = new URL(`/v1/runs/${encodeURIComponent(runId)}/events`, apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (since > 0) u.searchParams.set('since', String(since));
  return u.toString();
}

const TERMINAL = new Set(['merged', 'abandoned']);

/** The run state carried by an event: a Run payload, or `{ run }` (run.state / run.claimed / pr.opened). */
function runState(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if ('run' in payload) return runState(payload.run);
  return 'state' in payload ? String(payload.state) : undefined;
}

export function isTerminalEvent(e: RunEventMessage): boolean {
  const state = runState(e.payload);
  return state !== undefined && TERMINAL.has(state);
}

const one = (s: unknown, max = 160): string => {
  const text = (typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s))
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

/** Short summary of a tool input: the first string-ish field (file path, command, …). */
function briefInput(input: unknown): string {
  const o = obj(input);
  for (const k of [
    'file_path',
    'path',
    'command',
    'cmd',
    'pattern',
    'url',
    'query',
    'description',
  ]) {
    if (typeof o[k] === 'string') return one(o[k], 100);
  }
  const json = JSON.stringify(input ?? {});
  return json === '{}' ? '' : one(json, 100);
}

/** Label + detail for an AgentEvent payload. */
function agentLine(p: Obj): [string, string] {
  switch (p.type) {
    case 'session.started':
      return [
        'session',
        `${String(p.sessionId)}${typeof p.model === 'string' ? ` (${p.model})` : ''}`,
      ];
    case 'message':
      return [p.role === 'user' ? 'user' : 'assistant', one(p.text, 400)];
    case 'reasoning':
      return ['thinking', one(p.text)];
    case 'tool.call':
      return ['tool', `→ ${String(p.name)} ${briefInput(p.input)}`.trimEnd()];
    case 'tool.result':
      return ['tool', `← ${p.isError ? 'error' : 'ok'}${p.output ? ` ${one(p.output, 120)}` : ''}`];
    case 'file.change':
      return [
        'files',
        (Array.isArray(p.changes) ? p.changes : [])
          .map((c) => `${String(obj(c).kind)} ${String(obj(c).path)}`)
          .join(', '),
      ];
    case 'todo':
      return [
        'todo',
        (Array.isArray(p.items) ? p.items : [])
          .map((i) => `[${obj(i).done ? 'x' : ' '}] ${one(obj(i).text, 60)}`)
          .join('  '),
      ];
    case 'turn.completed': {
      const u = obj(p.usage);
      const cost = typeof u.costUsd === 'number' ? ` $${u.costUsd.toFixed(4)}` : '';
      const tokens =
        typeof u.inputTokens === 'number'
          ? ` ${String(u.inputTokens)} in / ${String(u.outputTokens)} out`
          : '';
      return ['turn', `${p.isError ? 'failed' : 'done'}${cost}${tokens}`];
    }
    case 'error':
      return ['error', `${p.fatal ? 'fatal: ' : ''}${one(p.message, 400)}`];
    default:
      return ['agent', one(JSON.stringify(p))];
  }
}

/** Label + human detail for any stored run event (unknown/legacy types fall back to JSON). */
export function describeEvent(e: RunEventMessage): [string, string] {
  const p = obj(e.payload);
  switch (e.type) {
    case 'agent':
      return agentLine(p);
    case 'diff.snapshot': {
      const st = obj(p.stats);
      return [
        'diff',
        `turn ${String(p.turn)}: ${String(st.files)} file(s) +${String(st.additions)} -${String(st.deletions)}${p.truncated ? ' (patch too large)' : ''}`,
      ];
    }
    case 'user.message':
      return ['you', one(p.text, 400)];
    case 'run.state':
      return ['state', `${String(p.from)} → ${String(p.to)}`];
    case 'run.claimed':
      return ['claimed', `by ${String(p.machineId)}`];
    case 'run.cancel_requested':
      return ['cancel', `requested by ${String(p.by)}`];
    case 'pr.opened':
      return ['pr', String(p.url)];
  }
  const state = runState(e.payload);
  return [
    e.type,
    state !== undefined
      ? `state=${state}`
      : typeof e.payload === 'string'
        ? e.payload
        : JSON.stringify(e.payload),
  ];
}

export function formatEvent(e: RunEventMessage): string {
  const at = new Date(e.at).toISOString().slice(11, 19);
  const [label, detail] = describeEvent(e);
  return `${String(e.seq).padStart(4)}  ${at}  ${label.padEnd(12)}  ${detail}`;
}
