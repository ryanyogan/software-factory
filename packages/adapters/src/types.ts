import type { AgentEvent } from '@sf/contract';

/** Adapters this package implements. `fake` is scripted (tests, gate); `opencode` is deferred. */
export type AdapterName = 'claude-code' | 'codex' | 'fake';
export const adapterNames: readonly AdapterName[] = ['claude-code', 'codex', 'fake'];

/**
 * Which agent binary to run.
 * - `'auto'` (default): the agent CLI found on `PATH` (`claude` / `codex`), else the SDK's bundled one.
 * - `'bundled'`: always the SDK's bundled binary (from its platform optional dependency).
 * - any other string: an absolute path to the binary.
 */
export type BinaryChoice = 'auto' | 'bundled' | (string & {});

export interface StartAgentOptions {
  /** Working directory (the task worktree). The agent may only write inside it (plus `additionalDirectories`). */
  cwd: string;
  /** First user prompt. Must be non-empty. */
  prompt: string;
  /** Resume an earlier agent session (Claude session id / Codex thread id) instead of starting fresh. */
  resumeSessionId?: string;
  /** Aborting this signal is the same as `session.cancel()`. */
  signal?: AbortSignal;
  /**
   * Base environment for the agent process. Defaults to `process.env`. The SDKs REPLACE the child env
   * with whatever they are given, so adapters always build the full env from this (see `buildAgentEnv`).
   */
  env?: Record<string, string | undefined>;
  /** Extra variables merged over `env`. */
  extraEnv?: Record<string, string>;
  /** Keep provider API keys (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `OPENAI_API_KEY`) in the child env. Default false: subscription logins are used. */
  allowApiKeys?: boolean;
  /** Model override (else the agent's own default / user config). */
  model?: string;
  /** See `BinaryChoice`. */
  binary?: BinaryChoice;
  /** Extra directories the agent may write to besides `cwd` (absolute). */
  additionalDirectories?: string[];
  /** Agent stderr / diagnostics. */
  onStderr?: (chunk: string) => void;
}

/** Token totals for a whole session (sum of per-turn usage). `inputTokens` includes cached input. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface AgentResult {
  /** True when the session ended without a fatal error, was not cancelled, and its last turn did not fail. */
  ok: boolean;
  cancelled: boolean;
  /** Agent session id for `resumeSessionId` (null if the agent never started one). */
  sessionId: string | null;
  /** Sum of this session's per-turn cost deltas in USD. Undefined when the agent reports no cost (Codex). */
  costUsd?: number;
  usage: SessionUsage;
  /** Number of `turn.completed` events emitted. */
  turns: number;
  /** Fatal error message when `ok` is false and not cancelled. */
  error?: string;
}

/**
 * One running agent session. The daemon drives every adapter the same way:
 *
 * ```ts
 * const s = await startAgent({ agent, cwd, prompt, resumeSessionId, signal });
 * for await (const ev of s.events) { forward(ev); if (ev.type === 'turn.completed' && s.idle) maybeEnd(); }
 * const r = await s.result;
 * ```
 *
 * The session does NOT end on its own when a turn finishes: it waits for `send()` (next turn) until
 * `end()` (finish queued work, then stop) or `cancel()` (stop now).
 */
export interface AgentSession {
  readonly agent: AdapterName;
  /** Normalized events, in order. Single consumer. Ends after the session finishes. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Agent session id once known (after `session.started`). */
  readonly sessionId: string | null;
  /** True when no turn is running and no follow-up is queued. */
  readonly idle: boolean;
  /**
   * Queue a follow-up user message. Semantics differ by agent:
   * - claude-code: streamed into the live session immediately; Claude may fold it into the running
   *   turn (between tool calls) or run it as the next turn.
   * - codex / fake: queued; runs as the next turn on the same thread once the current turn finishes
   *   (several queued messages are joined into one turn).
   * Throws after `end()`/`cancel()` or once the session has finished.
   */
  send(text: string): void;
  /** No more input: finish the running and queued turns, then end the session. Idempotent. */
  end(): void;
  /** Stop now: abort the running turn, drop queued follow-ups, end the session. Idempotent. */
  cancel(): void;
  /** Settles (never rejects) once the session has ended and `events` is drained of new items. */
  readonly result: Promise<AgentResult>;
}

export interface AgentAdapter {
  readonly name: AdapterName;
  start(options: StartAgentOptions): Promise<AgentSession>;
}
