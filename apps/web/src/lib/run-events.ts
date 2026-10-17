import { Run } from '@sf/contract';
import { type QueryClient, queryOptions, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { keys } from './queries';

/** Matches `StoredRunEvent` from sf-api's RunLog. */
export interface RunEvent {
  seq: number;
  type: string;
  payload: unknown;
  at: number;
}

/** Events are fed only by the socket; the query is just the cache slot. */
export const runEventsQuery = (runId: string) =>
  queryOptions<RunEvent[]>({
    queryKey: keys.events(runId),
    queryFn: () => [],
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });

/** Merge an event into the cache (dedupe by seq) and patch the run when the payload is a Run. */
export function applyRunEvent(qc: QueryClient, runId: string, event: RunEvent) {
  qc.setQueryData<RunEvent[]>(keys.events(runId), (prev = []) =>
    prev.some((e) => e.seq === event.seq) ? prev : [...prev, event].sort((a, b) => a.seq - b.seq),
  );
  // run.started carries a Run; run.state / run.claimed / pr.opened carry `{ run }`.
  const p = event.payload;
  const run = Run.safeParse(p && typeof p === 'object' && 'run' in p ? p.run : p);
  if (run.success && run.data.id === runId) {
    qc.setQueryData(keys.run(runId), run.data);
    void qc.invalidateQueries({ queryKey: ['run.list'] });
  }
}

export type SocketStatus = 'connecting' | 'live' | 'closed';

/** Tails `/v1/runs/:id/events` (proxied by web to the RunLog DO), resuming with `?since=`. */
export function useRunEvents(runId: string): SocketStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SocketStatus>('connecting');

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    const connect = () => {
      const events = qc.getQueryData<RunEvent[]>(keys.events(runId)) ?? [];
      const since = events.at(-1)?.seq ?? 0;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      setStatus('connecting');
      ws = new WebSocket(`${proto}//${location.host}/v1/runs/${runId}/events?since=${since}`);
      ws.onopen = () => {
        attempt = 0;
        setStatus('live');
      };
      ws.onmessage = (m) => {
        if (typeof m.data !== 'string' || m.data === 'pong') return;
        try {
          applyRunEvent(qc, runId, JSON.parse(m.data) as RunEvent);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setStatus('closed');
        if (stopped) return;
        retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [qc, runId]);

  return status;
}
