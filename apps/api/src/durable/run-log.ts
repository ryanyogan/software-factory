import { DurableObject } from 'cloudflare:workers';
import { RunLogClientFrame, type RunLogServerFrame, type StoredRunEvent } from '@sf/contract';
import type { RunEventInput } from '@sf/core';
import { SF_HEADERS } from './identity';

export type { StoredRunEvent };

type EventRow = {
  seq: number;
  type: string;
  payload: string;
  at: number;
  emitted_at: number | null;
};

/** Per-socket identity, set by the Worker route after auth (survives hibernation). */
export interface RunLogSocket {
  role: 'viewer' | 'writer';
  userId: string;
  machineId: string | null;
}

const toEvent = (r: EventRow): StoredRunEvent => ({
  seq: r.seq,
  type: r.type,
  payload: JSON.parse(r.payload) as unknown,
  at: r.at,
  ...(r.emitted_at === null ? {} : { emittedAt: r.emitted_at }),
});

const COLS = 'seq, type, payload, at, emitted_at';

/**
 * One instance per run (`env.RUN_LOG.getByName(runId)`). Append-only event log in SQLite;
 * live tail over hibernatable WebSockets, replaying from `?since=<seq>` on connect.
 * Every appended event is pushed to every socket (so the daemon receives `user.message` /
 * `run.cancel_requested` on its writer socket), except back to the writer socket that sent it.
 */
export class RunLog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    // Stage 8 columns, added in place so Phase 0 logs keep their events.
    const cols = new Set(
      sql
        .exec<{ name: string }>(`SELECT name FROM pragma_table_info('events')`)
        .toArray()
        .map((c) => c.name),
    );
    if (!cols.has('emitted_at')) sql.exec('ALTER TABLE events ADD COLUMN emitted_at INTEGER');
    if (!cols.has('key')) sql.exec('ALTER TABLE events ADD COLUMN key TEXT');
    sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS events_key ON events (key)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private insert(event: RunEventInput): { stored: StoredRunEvent; fresh: boolean } {
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec<EventRow>(
        `INSERT INTO events (type, payload, at, emitted_at, key) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO NOTHING RETURNING ${COLS}`,
        event.type,
        JSON.stringify(event.payload ?? null),
        Date.now(),
        event.emittedAt ?? null,
        event.key ?? null,
      )
      .toArray();
    if (rows[0]) return { stored: toEvent(rows[0]), fresh: true };
    // Duplicate idempotency key: return the original, don't re-broadcast.
    const dup = sql.exec<EventRow>(`SELECT ${COLS} FROM events WHERE key = ?`, event.key).one();
    return { stored: toEvent(dup), fresh: false };
  }

  private broadcast(events: StoredRunEvent[], except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      for (const e of events) {
        try {
          ws.send(JSON.stringify(e));
        } catch {
          // socket already closing; ignore
        }
      }
    }
  }

  private appendAndPush(events: RunEventInput[], except?: WebSocket): StoredRunEvent[] {
    const results = events.map((e) => this.insert(e));
    this.broadcast(
      results.filter((r) => r.fresh).map((r) => r.stored),
      except,
    );
    return results.map((r) => r.stored);
  }

  /** Append in order and push to subscribers. Returns stored events (dupes → originals). */
  async appendMany(events: RunEventInput[]): Promise<StoredRunEvent[]> {
    return this.appendAndPush(events);
  }

  async append(event: RunEventInput): Promise<StoredRunEvent> {
    const [stored] = await this.appendMany([event]);
    return stored!;
  }

  async list(since = 0, limit = -1): Promise<StoredRunEvent[]> {
    return this.ctx.storage.sql
      .exec<EventRow>(`SELECT ${COLS} FROM events WHERE seq > ? ORDER BY seq LIMIT ?`, since, limit)
      .toArray()
      .map(toEvent);
  }

  /** Sockets by role (diagnostics/tests). */
  async connections(): Promise<{ viewer: number; writer: number }> {
    return {
      viewer: this.ctx.getWebSockets('viewer').length,
      writer: this.ctx.getWebSockets('writer').length,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const userId = request.headers.get(SF_HEADERS.user);
    if (!userId) return new Response('missing identity', { status: 400 });
    const machineId = request.headers.get(SF_HEADERS.machine);
    const role =
      request.headers.get(SF_HEADERS.role) === 'writer' && machineId ? 'writer' : 'viewer';
    const since = Number(new URL(request.url).searchParams.get('since') ?? 0) || 0;

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, userId, machineId } satisfies RunLogSocket);
    for (const event of await this.list(since)) server.send(JSON.stringify(event));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const reply = (frame: RunLogServerFrame) => ws.send(JSON.stringify(frame));
    const att = ws.deserializeAttachment() as RunLogSocket | null;
    if (att?.role !== 'writer') {
      return reply({ type: 'error', code: 'forbidden', message: 'read-only socket' });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return reply({ type: 'error', code: 'invalid_input', message: 'frame must be JSON' });
    }
    const frame = RunLogClientFrame.safeParse(raw);
    if (!frame.success) {
      return reply({ type: 'error', code: 'invalid_input', message: frame.error.message });
    }
    const stored = this.appendAndPush(frame.data.events, ws);
    reply({ type: 'ack', seqs: stored.map((e) => e.seq) });
  }
}
