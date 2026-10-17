import { TOOL_OUTPUT_MAX, type AgentEvent } from '@sf/contract';
import { Channel } from './channel';
import type { AdapterName, AgentResult, AgentSession, SessionUsage } from './types';

/** Cut tool output to the contract cap. */
export function capOutput(text: string): { output: string; truncated?: true } {
  if (text.length <= TOOL_OUTPUT_MAX) return { output: text };
  return { output: text.slice(0, TOOL_OUTPUT_MAX), truncated: true };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shared bookkeeping: event channel, usage/cost totals, session id, the final result. */
export class SessionState {
  readonly events = new Channel<AgentEvent>();
  sessionId: string | null;
  turns = 0;
  costUsd: number | undefined;
  usage: SessionUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  lastTurnError = false;
  fatal: string | undefined;
  cancelled = false;
  #finished = false;
  #resolve!: (r: AgentResult) => void;
  readonly result: Promise<AgentResult> = new Promise((r) => (this.#resolve = r));

  constructor(sessionId: string | null = null) {
    this.sessionId = sessionId;
  }

  get finished(): boolean {
    return this.#finished;
  }

  emit(ev: AgentEvent): void {
    if (this.#finished) return;
    if (ev.type === 'session.started') this.sessionId = ev.sessionId;
    if (ev.type === 'turn.completed') {
      this.turns++;
      this.lastTurnError = ev.isError;
      if (ev.usage) {
        this.usage.inputTokens += ev.usage.inputTokens;
        this.usage.outputTokens += ev.usage.outputTokens;
        this.usage.cachedInputTokens += ev.usage.cachedInputTokens ?? 0;
        if (ev.usage.costUsd !== undefined) this.costUsd = (this.costUsd ?? 0) + ev.usage.costUsd;
      }
    }
    if (ev.type === 'error' && ev.fatal) this.fatal ??= ev.message;
    this.events.push(ev);
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.events.close();
    this.#resolve({
      ok: !this.cancelled && this.fatal === undefined && !this.lastTurnError,
      cancelled: this.cancelled,
      sessionId: this.sessionId,
      ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
      usage: { ...this.usage },
      turns: this.turns,
      ...(this.fatal !== undefined && !this.cancelled ? { error: this.fatal } : {}),
    });
  }
}

/** One turn of a turn-based agent (Codex, fake): run `input`, emit its events, resolve when the turn ends. */
export type RunTurn = (
  input: string,
  ctx: { signal: AbortSignal; turn: number; emit: (ev: AgentEvent) => void },
) => Promise<void>;

/**
 * Session for agents that cannot be steered mid-turn: follow-ups queue and run as the next turn
 * (queued messages are joined with a blank line into one turn). A thrown turn is reported as a
 * non-fatal `error` + failed `turn.completed`; the session keeps accepting follow-ups.
 */
export function createTurnSession(
  agent: AdapterName,
  runTurn: RunTurn,
  opts: { prompt: string; signal?: AbortSignal; sessionId?: string | null },
): AgentSession {
  const state = new SessionState(opts.sessionId ?? null);
  const queue: string[] = [opts.prompt];
  let ended = false;
  let running = false;
  let turnAbort: AbortController | null = null;
  let wake: (() => void) | null = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  const cancel = () => {
    if (state.finished || state.cancelled) return;
    state.cancelled = true;
    queue.length = 0;
    turnAbort?.abort();
    poke();
  };
  if (opts.signal?.aborted) cancel();
  opts.signal?.addEventListener('abort', cancel, { once: true });

  const loop = async () => {
    let turn = 0;
    for (;;) {
      if (state.cancelled) break;
      if (queue.length > 0) {
        const input = queue.splice(0).join('\n\n');
        turn++;
        running = true;
        turnAbort = new AbortController();
        const before = state.turns;
        try {
          await runTurn(input, {
            signal: turnAbort.signal,
            turn,
            emit: (ev) => {
              // Idle flips before the consumer sees turn.completed, so `if (s.idle)` after it is reliable.
              if (ev.type === 'turn.completed') running = false;
              state.emit(ev);
            },
          });
        } catch (e) {
          if (!state.cancelled) {
            const message = errorMessage(e);
            state.emit({ type: 'error', message, fatal: false });
            if (state.turns === before) {
              running = false;
              state.emit({ type: 'turn.completed', isError: true, result: message });
            }
          }
        }
        running = false;
        turnAbort = null;
        if (state.fatal !== undefined) break; // a fatal error ends the session
        continue;
      }
      if (ended) break;
      await new Promise<void>((r) => (wake = r));
    }
    opts.signal?.removeEventListener('abort', cancel);
    state.finish();
  };
  void loop();

  return {
    agent,
    events: state.events,
    get sessionId() {
      return state.sessionId;
    },
    get idle() {
      return !running && queue.length === 0;
    },
    send(text: string) {
      if (ended || state.cancelled || state.finished) throw new Error(`${agent} session is closed`);
      if (!text.trim()) throw new Error('follow-up text is empty');
      queue.push(text);
      poke();
    },
    end() {
      ended = true;
      poke();
    },
    cancel,
    result: state.result,
  };
}
