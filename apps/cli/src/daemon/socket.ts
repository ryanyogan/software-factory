import type { Client } from '@sf/contract';

/** The subset of the WHATWG WebSocket the daemon uses (Node 24's undici WebSocket, or a test fake). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', fn: (ev: unknown) => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

export const WS_OPEN = 1;

/** How the daemon reaches the API: the typed command client + WebSockets carrying its identity. */
export interface DaemonTransport {
  client: Client;
  /** Open `path` (e.g. `/v1/projects/prj_1/room`) with `Authorization` and `x-sf-machine` set. */
  connect(path: string): WebSocketLike;
}

/** Real transport: `createClient` + Node's WebSocket with headers (no Origin → Bearer/dev bypass). */
export function nodeTransport(opts: {
  apiUrl: string;
  client: Client;
  token?: string;
  machineId: string;
}): DaemonTransport {
  return {
    client: opts.client,
    connect(path) {
      const u = new URL(path, opts.apiUrl);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      const headers: Record<string, string> = { 'x-sf-machine': opts.machineId };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      // undici accepts `{ headers }` as the 2nd argument; the DOM typing only knows protocols.
      return new WebSocket(u, { headers } as unknown as string[]) as unknown as WebSocketLike;
    },
  };
}

export interface SocketTimings {
  /** First reconnect delay (ms); doubles up to `maxBackoffMs`, with jitter. */
  minBackoffMs: number;
  maxBackoffMs: number;
  /** An open lasting this long resets the backoff. */
  stableMs: number;
  /** Heartbeat `ping` interval; no `pong` within `pongTimeoutMs` → reconnect. */
  pingMs: number;
  pongTimeoutMs: number;
}

export const defaultTimings: SocketTimings = {
  minBackoffMs: 500,
  maxBackoffMs: 30_000,
  stableMs: 10_000,
  pingMs: 25_000,
  pongTimeoutMs: 10_000,
};

/**
 * A WebSocket that reconnects with exponential backoff + jitter and heartbeats (research §7).
 * `open()` is called for every (re)connect, so it can put the latest `?since=` in the path.
 */
export class ManagedSocket {
  private ws: WebSocketLike | undefined;
  private stopped = false;
  private attempt = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private openedAt = 0;

  constructor(
    private readonly opts: {
      open: () => WebSocketLike;
      onMessage: (text: string) => void;
      onOpen?: () => void;
      onClose?: () => void;
      log?: (msg: string) => void;
      label: string;
      timings?: Partial<SocketTimings>;
    },
  ) {}

  private get t(): SocketTimings {
    return { ...defaultTimings, ...this.opts.timings };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Send if open; returns false (nothing sent) otherwise. */
  send(text: string): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    try {
      this.ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000, 'bye');
    } catch {
      // already closed
    }
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocketLike;
    try {
      ws = this.opts.open();
    } catch (e) {
      this.opts.log?.(`${this.opts.label}: connect failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let closed = false;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.openedAt = Date.now();
      this.startHeartbeat(ws);
      this.opts.onOpen?.();
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (text === 'pong') {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        return;
      }
      this.opts.onMessage(text);
    });
    const onDown = () => {
      if (closed) return;
      closed = true;
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.clearHeartbeat();
      this.opts.onClose?.();
      if (this.openedAt && Date.now() - this.openedAt >= this.t.stableMs) this.attempt = 0;
      this.openedAt = 0;
      this.scheduleReconnect();
    };
    ws.addEventListener('close', onDown);
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      onDown();
    });
  }

  private startHeartbeat(ws: WebSocketLike): void {
    this.clearHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WS_OPEN) return;
      try {
        ws.send('ping');
      } catch {
        return;
      }
      if (!this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          this.opts.log?.(`${this.opts.label}: no pong, reconnecting`);
          try {
            ws.close(4000, 'no pong');
          } catch {
            // ignore
          }
        }, this.t.pongTimeoutMs);
      }
    }, this.t.pingMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const { minBackoffMs, maxBackoffMs } = this.t;
    const base = Math.min(maxBackoffMs, minBackoffMs * 2 ** this.attempt);
    this.attempt++;
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.later(delay, () => this.connect());
  }
}
