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

export function formatEvent(e: RunEventMessage): string {
  const at = new Date(e.at).toISOString().slice(11, 19);
  const state = runState(e.payload);
  const detail =
    state !== undefined
      ? `state=${state}`
      : typeof e.payload === 'string'
        ? e.payload
        : JSON.stringify(e.payload);
  return `${String(e.seq).padStart(4)}  ${at}  ${e.type.padEnd(16)}  ${detail}`;
}
