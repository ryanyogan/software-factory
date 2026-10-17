import { randomUUID } from 'node:crypto';
import {
  type DaemonEventInput,
  EVENT_BATCH_MAX,
  RunLogServerFrame,
  type StoredRunEvent,
} from '@sf/contract';
import { type DaemonTransport, ManagedSocket, type SocketTimings } from './socket';

/** Keep WS frames well under the Workers message limit; bigger single events go over HTTP. */
export const FRAME_MAX_CHARS = 512 * 1024;

type Keyed = DaemonEventInput & { key: string };

/**
 * The daemon's writer connection to one run's RunLog:
 *  - `append()` buffers; a flush (next tick) sends one `append` frame per ≤500 events / ≤512 KiB,
 *    and the DO acks each frame in order.
 *  - Every event has an idempotency key (`<machine>:<nonce>:<n>`), so frames unacked when the socket
 *    drops are simply resent; while the socket is down, batches go through `run.append` (HTTP).
 *  - Incoming frames (other than acks) are the run's StoredRunEvents: follow-ups, cancel, state.
 */
export class RunLogWriter {
  private readonly socket: ManagedSocket;
  private readonly nonce = randomUUID().slice(0, 8);
  private counter = 0;
  private pending: Keyed[] = [];
  private inflight: Keyed[][] = [];
  private httpBusy = false;
  private scheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private waiters: (() => void)[] = [];
  private closed = false;
  private graceUntil = 0;
  lastSeq: number;

  constructor(
    private readonly opts: {
      runId: string;
      machineId: string;
      transport: DaemonTransport;
      since: number;
      onEvent: (e: StoredRunEvent) => void;
      log?: (msg: string) => void;
      timings?: Partial<SocketTimings>;
    },
  ) {
    this.lastSeq = opts.since;
    this.socket = new ManagedSocket({
      label: `runlog ${opts.runId}`,
      log: opts.log,
      timings: opts.timings,
      open: () =>
        opts.transport.connect(
          `/v1/runs/${encodeURIComponent(opts.runId)}/events?since=${this.lastSeq}`,
        ),
      onOpen: () => {
        this.graceUntil = 0;
        this.schedule();
      },
      onClose: () => {
        // Unacked frames go back to the front; keys make the resend idempotent.
        this.pending = [...this.inflight.flat(), ...this.pending];
        this.inflight = [];
        this.schedule();
      },
      onMessage: (text) => this.onMessage(text),
    });
  }

  start(): void {
    this.graceUntil = Date.now() + 2000;
    this.socket.start();
  }

  get connected(): boolean {
    return this.socket.isOpen;
  }

  append(event: DaemonEventInput): void {
    if (this.closed) throw new Error('writer closed');
    this.pending.push({
      ...event,
      key: event.key ?? `${this.opts.machineId}:${this.nonce}:${++this.counter}`,
    });
    this.schedule();
  }

  /** Resolves once every appended event has been acknowledged (WS ack or HTTP response). */
  flush(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Flush (bounded by `timeoutMs`), then close the socket for good. */
  async close(timeoutMs = 10_000): Promise<void> {
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket.stop();
    this.wake();
  }

  private get idle(): boolean {
    return this.pending.length === 0 && this.inflight.length === 0 && !this.httpBusy;
  }

  private wake(): void {
    if (!this.idle && !this.closed) return;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  /** Next batch from `pending`: ≤ EVENT_BATCH_MAX events and ≤ FRAME_MAX_CHARS (at least one). */
  private takeBatch(): { batch: Keyed[]; size: number } {
    let size = 0;
    let n = 0;
    while (n < this.pending.length && n < EVENT_BATCH_MAX) {
      const s = JSON.stringify(this.pending[n]).length;
      if (n > 0 && size + s > FRAME_MAX_CHARS) break;
      size += s;
      n++;
    }
    return { batch: this.pending.splice(0, n), size };
  }

  private async drain(): Promise<void> {
    while (this.pending.length && !this.closed) {
      const fits = JSON.stringify(this.pending[0]).length <= FRAME_MAX_CHARS;
      if (fits && !this.socket.isOpen && Date.now() < this.graceUntil) {
        // The first connect is still in progress: wait for it rather than going HTTP at once.
        this.retryLater(50);
        return;
      }
      if (fits && this.socket.isOpen) {
        const { batch } = this.takeBatch();
        if (this.socket.send(JSON.stringify({ type: 'append', events: batch }))) {
          this.inflight.push(batch);
          continue;
        }
        this.pending.unshift(...batch);
      }
      if (this.httpBusy) return;
      await this.sendHttp();
      if (this.retryTimer) return;
    }
    this.wake();
  }

  /** HTTP batch fallback (`run.append`), also used for single events too big for a WS frame. */
  private async sendHttp(): Promise<void> {
    const { batch } = this.takeBatch();
    this.httpBusy = true;
    try {
      await this.opts.transport.client.call('run.append', {
        id: this.opts.runId,
        machineId: this.opts.machineId,
        events: batch,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'forbidden' || code === 'invalid_input' || code === 'not_found') {
        this.opts.log?.(
          `runlog ${this.opts.runId}: dropped ${batch.length} event(s): ${String(e)}`,
        );
      } else {
        this.pending.unshift(...batch);
        this.retryLater(1000);
      }
    } finally {
      this.httpBusy = false;
    }
  }

  private retryLater(ms: number): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.schedule();
    }, ms);
  }

  private onMessage(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const frame = RunLogServerFrame.safeParse(raw);
    if (frame.success) {
      const batch = this.inflight.shift();
      if (frame.data.type === 'error') {
        this.opts.log?.(
          `runlog ${this.opts.runId}: append rejected (${frame.data.code}): ${frame.data.message}` +
            (batch ? `, dropped ${batch.length} event(s)` : ''),
        );
      }
      this.wake();
      return;
    }
    const e = raw as StoredRunEvent;
    if (typeof e?.seq !== 'number' || typeof e.type !== 'string') return;
    if (e.seq > this.lastSeq) this.lastSeq = e.seq;
    this.opts.onEvent(e);
  }
}
