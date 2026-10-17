import { ProjectNotice } from '@sf/contract';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { keys } from './queries';

/** Apply a ProjectRoom notice to the query cache: patch the run, refresh run lists. */
export function applyProjectNotice(qc: QueryClient, notice: ProjectNotice) {
  if (notice.type === 'run.queued' || notice.type === 'run.state') {
    qc.setQueryData(keys.run(notice.run.id), notice.run);
    void qc.invalidateQueries({ queryKey: ['run.list'] });
  }
}

/**
 * Live "Needs you" / task pages: one viewer socket per project room (`/v1/projects/:id/room`,
 * proxied by web). Notices patch `run.get` and invalidate `run.list`; reconnects with backoff.
 * No replay on reconnect, so a (re)connect also invalidates `run.list` to catch up.
 */
export function useProjectRooms(projectIds: readonly string[]) {
  const qc = useQueryClient();
  const idsKey = [...new Set(projectIds)].sort().join(',');

  useEffect(() => {
    if (!idsKey) return;
    const stops = idsKey.split(',').map((id) => watchRoom(qc, id));
    return () => {
      for (const stop of stops) stop();
    };
  }, [qc, idsKey]);
}

function watchRoom(qc: QueryClient, projectId: string): () => void {
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let attempt = 0;
  let opened = false;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/v1/projects/${projectId}/room`);
    ws.onopen = () => {
      attempt = 0;
      // The first open follows a fresh loader fetch; later ones may have missed notices.
      if (opened) void qc.invalidateQueries({ queryKey: ['run.list'] });
      opened = true;
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string' || m.data === 'pong') return;
      try {
        const notice = ProjectNotice.safeParse(JSON.parse(m.data));
        if (notice.success) applyProjectNotice(qc, notice.data);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    closeQuietly(ws);
  };
}

/** Close without the browser's "closed before the connection is established" warning. */
function closeQuietly(ws: WebSocket | undefined) {
  if (!ws) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.onopen = () => ws.close();
    ws.onmessage = null;
  } else ws.close();
}
