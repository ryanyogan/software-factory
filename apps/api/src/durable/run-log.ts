import { DurableObject } from 'cloudflare:workers';
import type { RunEvent } from '@sf/core';

export interface StoredRunEvent extends RunEvent {
  seq: number;
  /** ms since epoch */
  at: number;
}

type EventRow = { seq: number; type: string; payload: string; at: number };

const toEvent = (r: EventRow): StoredRunEvent => ({
  seq: r.seq,
  type: r.type,
  payload: JSON.parse(r.payload) as unknown,
  at: r.at,
});

/**
 * One instance per run (`env.RUN_LOG.getByName(runId)`). Append-only event log in SQLite;
 * live tail over hibernatable WebSockets, replaying from `?since=<seq>` on connect.
 */
export class RunLog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
  }

  async append(event: RunEvent): Promise<StoredRunEvent> {
    const row = this.ctx.storage.sql
      .exec<EventRow>(
        'INSERT INTO events (type, payload, at) VALUES (?, ?, ?) RETURNING seq, type, payload, at',
        event.type,
        JSON.stringify(event.payload ?? null),
        Date.now(),
      )
      .one();
    const stored = toEvent(row);
    const msg = JSON.stringify(stored);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // socket already closing; ignore
      }
    }
    return stored;
  }

  async list(since = 0): Promise<StoredRunEvent[]> {
    return this.ctx.storage.sql
      .exec<EventRow>('SELECT seq, type, payload, at FROM events WHERE seq > ? ORDER BY seq', since)
      .toArray()
      .map(toEvent);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const since = Number(new URL(request.url).searchParams.get('since') ?? 0) || 0;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    for (const event of await this.list(since)) server.send(JSON.stringify(event));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Read-only log for clients; only answer pings.
    if (message === 'ping') ws.send('pong');
  }
}
