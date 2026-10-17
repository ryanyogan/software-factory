// Test-only: an in-memory API (core dispatch on libsql + RunLog/ProjectRoom semantics over fake
// WebSockets), so daemon tests run end to end in plain Node without workerd. Not imported by the CLI.
import { fileURLToPath } from 'node:url';
import { createClient as createLibsql } from '@libsql/client';
import {
  type Client,
  type CommandName,
  type ProjectNotice,
  RunLogClientFrame,
  type StoredRunEvent,
} from '@sf/contract';
import { authorizeWriter, type Ctx, createMemoryEvents, dispatch } from '@sf/core';
import { schema } from '@sf/db';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { DaemonTransport, WebSocketLike } from './socket';

const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

type Listener = (ev: never) => void;

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  private listeners = new Map<string, Listener[]>();
  onSend: (data: string) => void = () => undefined;

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  emit(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as (e: unknown) => void)(ev);
  }

  /** Server → client frame (async, like a real socket). */
  push(data: string): void {
    queueMicrotask(() => {
      if (this.readyState === 1) this.emit('message', { data });
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    if (data === 'ping') return this.push('pong');
    this.onSend(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', { code: 1000 }));
  }
}

interface LogSocket {
  runId: string;
  socket: FakeSocket;
  writer: boolean;
}

export interface Hub {
  ctx: Ctx;
  /** The owner's client (same user as every transport). */
  client: Client;
  transport(machineId: string): DaemonTransport;
  events(runId: string): StoredRunEvent[];
  /** Drop every open socket (simulates a network blip). */
  dropAll(): void;
  /** Make new connections fail while true. */
  offline: boolean;
  /** WS append frames received (vs HTTP run.append calls). */
  stats: { wsFrames: number; httpAppends: number };
}

export async function createHub(userId = 'dev'): Promise<Hub> {
  const db = drizzle(createLibsql({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder });
  const mem = createMemoryEvents();
  const logSockets = new Set<LogSocket>();
  const roomSockets = new Map<string, Set<FakeSocket>>();
  const stats = { wsFrames: 0, httpAppends: 0 };

  const fanout = (runId: string, stored: StoredRunEvent[], except?: FakeSocket) => {
    for (const s of logSockets) {
      if (s.runId !== runId || s.socket === except) continue;
      for (const e of stored) s.socket.push(JSON.stringify(e));
    }
  };

  const ctx: Ctx = {
    db,
    userId,
    events: {
      async append(runId, events) {
        const before = mem.runs.get(runId)?.length ?? 0;
        const stored = await mem.append(runId, events);
        fanout(
          runId,
          stored.filter((e) => e.seq > before),
        );
        return stored;
      },
      list: (runId, since, limit) => mem.list(runId, since, limit),
      async notifyProject(projectId, notice: ProjectNotice) {
        for (const s of roomSockets.get(projectId) ?? []) s.push(JSON.stringify(notice));
      },
    },
  };

  const client: Client = {
    async call(name, input) {
      if (name === 'run.append') stats.httpAppends++;
      // JSON round trip, like the wire.
      const out = await dispatch(ctx, name as CommandName, JSON.parse(JSON.stringify(input ?? {})));
      return JSON.parse(JSON.stringify(out)) as never;
    },
  };

  const hub: Hub = {
    ctx,
    client,
    offline: false,
    stats,
    events: (runId) => mem.runs.get(runId) ?? [],
    dropAll() {
      for (const s of logSockets) s.socket.close();
      for (const set of roomSockets.values()) for (const s of set) s.close();
    },
    transport(machineId) {
      return {
        client,
        connect(path) {
          const socket = new FakeSocket();
          const url = new URL(path, 'http://hub');
          const run = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
          const room = /^\/v1\/projects\/([^/]+)\/room$/.exec(url.pathname);
          void (async () => {
            await Promise.resolve();
            if (hub.offline) {
              socket.readyState = 3;
              socket.emit('error');
              socket.emit('close');
              return;
            }
            if (room) {
              const id = decodeURIComponent(room[1]!);
              const set = roomSockets.get(id) ?? new Set();
              roomSockets.set(id, set);
              set.add(socket);
              socket.addEventListener('close', () => set.delete(socket));
              socket.readyState = 1;
              socket.emit('open');
              return;
            }
            if (!run) throw new Error(`hub: no route ${path}`);
            const runId = decodeURIComponent(run[1]!);
            try {
              await authorizeWriter(ctx, runId, machineId);
            } catch {
              socket.readyState = 3;
              socket.emit('error');
              socket.emit('close');
              return;
            }
            const entry: LogSocket = { runId, socket, writer: true };
            logSockets.add(entry);
            socket.addEventListener('close', () => logSockets.delete(entry));
            socket.onSend = (data) => {
              stats.wsFrames++;
              const frame = RunLogClientFrame.safeParse(JSON.parse(data));
              if (!frame.success) {
                socket.push(
                  JSON.stringify({ type: 'error', code: 'invalid_input', message: 'bad' }),
                );
                return;
              }
              void (async () => {
                const before = mem.runs.get(runId)?.length ?? 0;
                const stored = await mem.append(runId, frame.data.events);
                // The writer's own frames are not echoed back to it (like the RunLog DO).
                fanout(
                  runId,
                  stored.filter((e) => e.seq > before),
                  socket,
                );
                socket.push(JSON.stringify({ type: 'ack', seqs: stored.map((e) => e.seq) }));
              })();
            };
            socket.readyState = 1;
            socket.emit('open');
            const since = Number(url.searchParams.get('since') ?? 0);
            for (const e of await mem.list(runId, since, 1e9)) socket.push(JSON.stringify(e));
          })();
          return socket;
        },
      };
    },
  };
  return hub;
}
