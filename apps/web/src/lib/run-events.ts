import { Run } from '@sf/contract';
import { type QueryClient, queryOptions, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { keys } from './queries';
import { type RawRunEvent, mergeEvents } from './transcript';

/** Matches `StoredRunEvent` from sf-api's RunLog (typed view: `parseRunEvent` / `buildTranscript`). */
export type RunEvent = RawRunEvent;

/** Events are fed only by the socket (replay `?since=` + live); the query is just the cache slot. */
export const runEventsQuery = (runId: string) =>
  queryOptions<RunEvent[]>({
    queryKey: keys.events(runId),
    queryFn: () => [],
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });

/**
 * Merge events into the cache and patch `run.get` from any payload that carries the Run
 * (`run.started`, `run.claimed`, `run.state`, `pr.opened`). Also used for the event `run.message`
 * returns, so a follow-up shows before the socket delivers it.
 */
export function applyRunEvents(qc: QueryClient, runId: string, events: readonly RunEvent[]) {
  qc.setQueryData<RunEvent[]>(keys.events(runId), (prev = []) => mergeEvents(prev, events));
  let latest: Run | undefined;
  for (const event of events) {
    const p = event.payload;
    const run = Run.safeParse(p && typeof p === 'object' && 'run' in p ? p.run : p);
    if (run.success && run.data.id === runId) latest = run.data;
  }
  if (latest) {
    qc.setQueryData(keys.run(runId), latest);
    void qc.invalidateQueries({ queryKey: ['run.list'] });
  }
}

export const applyRunEvent = (qc: QueryClient, runId: string, event: RunEvent) =>
  applyRunEvents(qc, runId, [event]);

export type SocketStatus = 'connecting' | 'live' | 'closed';

/**
 * Tails `/v1/runs/:id/events` (proxied by web to the RunLog DO), resuming with `?since=<last seq>`.
 * Frames are batched per animation frame so a replay of hundreds of events renders once.
 */
export function useRunEvents(runId: string): SocketStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SocketStatus>('connecting');

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;
    let queue: RunEvent[] = [];
    let frame: number | undefined;

    const flush = () => {
      frame = undefined;
      const batch = queue;
      queue = [];
      if (batch.length) applyRunEvents(qc, runId, batch);
    };

    const connect = () => {
      flush();
      const events = qc.getQueryData<RunEvent[]>(keys.events(runId)) ?? [];
      const since = events.at(-1)?.seq ?? 0;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      setStatus('connecting');
      ws = new WebSocket(`${proto}//${location.host}/v1/runs/${runId}/events?since=${since}`);
      ws.onopen = () => {
        if (stopped) return;
        attempt = 0;
        setStatus('live');
      };
      ws.onmessage = (m) => {
        if (typeof m.data !== 'string' || m.data === 'pong') return;
        try {
          const e = JSON.parse(m.data) as RunEvent;
          if (typeof e.seq !== 'number') return; // control frames
          queue.push(e);
          frame ??= requestAnimationFrame(flush);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        // A socket from an unmounted effect (StrictMode remount, runId change) must not touch status:
        // it can close after the replacement socket is already live.
        if (stopped) return;
        setStatus('closed');
        retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      if (frame !== undefined) cancelAnimationFrame(frame);
      flush();
      closeQuietly(ws);
    };
  }, [qc, runId]);

  return status;
}

/** Close without the browser's "closed before the connection is established" warning. */
function closeQuietly(ws: WebSocket | undefined) {
  if (!ws) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.onopen = () => ws.close();
    ws.onmessage = null;
  } else ws.close();
}
