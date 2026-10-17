import type {
  CodexOptions,
  ModelReasoningEffort,
  SandboxMode,
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from '@openai/codex-sdk';
import { resolveBinary } from '../binaries';
import { buildAgentEnv } from '../env';
import { createTurnSession } from '../session';
import type { AgentAdapter, AgentSession, StartAgentOptions } from '../types';
import { createCodexMapper, type CodexUsageTotals } from './map';

export {
  createCodexMapper,
  type CodexMapper,
  type CodexMapperOptions,
  type CodexUsageTotals,
} from './map';

export interface CodexStartOptions extends StartAgentOptions {
  /** Default `workspace-write` (writes limited to cwd + additionalDirectories). */
  sandboxMode?: SandboxMode;
  networkAccessEnabled?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  /** Thread token totals before this session (resume): Codex usage is thread-cumulative. */
  usageBase?: CodexUsageTotals;
}

/** The slice of the SDK this adapter uses (test seam). */
export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    turnOptions?: TurnOptions,
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}
export interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}
export interface CodexDeps {
  /** Test seam: replaces `new (await import('@openai/codex-sdk')).Codex(options)`. */
  createCodex?: (options: CodexOptions) => Promise<CodexLike> | CodexLike;
}

/** SDK constructor + thread options for one run (exported for tests). */
export function codexOptions(opts: CodexStartOptions): {
  codex: CodexOptions;
  thread: ThreadOptions;
} {
  const env = buildAgentEnv({
    base: opts.env,
    allowApiKeys: opts.allowApiKeys,
    extra: opts.extraEnv,
  });
  const exe = resolveBinary(opts.binary, 'codex', env.PATH);
  return {
    codex: { env, ...(exe ? { codexPathOverride: exe } : {}) },
    thread: {
      workingDirectory: opts.cwd,
      sandboxMode: opts.sandboxMode ?? 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      ...(opts.additionalDirectories?.length
        ? { additionalDirectories: opts.additionalDirectories }
        : {}),
      ...(opts.networkAccessEnabled !== undefined
        ? { networkAccessEnabled: opts.networkAccessEnabled }
        : {}),
      ...(opts.modelReasoningEffort ? { modelReasoningEffort: opts.modelReasoningEffort } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    },
  };
}

/**
 * Codex via `@openai/codex-sdk`. Each turn is a fresh `codex exec --experimental-json [resume <id>]`
 * process, so there is no mid-turn steering: `send()` queues and the follow-up runs as the next
 * turn on the same thread. `cancel()` aborts the running turn (SIGTERM to the child). No cost data.
 */
export function createCodexAdapter(deps: CodexDeps = {}): AgentAdapter {
  return {
    name: 'codex',
    async start(input: StartAgentOptions): Promise<AgentSession> {
      const opts = input as CodexStartOptions;
      if (!opts.prompt.trim()) throw new Error('prompt is empty');
      // `onStderr` is not supported: the Codex SDK only surfaces stderr in the error a failed turn throws.
      const o = codexOptions(opts);
      const codex: CodexLike = deps.createCodex
        ? await deps.createCodex(o.codex)
        : new (await import('@openai/codex-sdk')).Codex(o.codex);
      const thread = opts.resumeSessionId
        ? codex.resumeThread(opts.resumeSessionId, o.thread)
        : codex.startThread(o.thread);
      const map = createCodexMapper({ usageBase: opts.usageBase });

      return createTurnSession(
        'codex',
        async (text, { signal, emit }) => {
          let completed = false;
          try {
            const { events } = await thread.runStreamed(text, { signal });
            for await (const e of events) {
              for (const ev of map(e)) {
                if (ev.type === 'turn.completed') completed = true;
                emit(ev);
              }
            }
          } catch (e) {
            // The SDK throws on a non-zero exit after `turn.failed`; that turn is already reported.
            if (!completed) throw e;
          }
        },
        { prompt: opts.prompt, signal: opts.signal, sessionId: opts.resumeSessionId ?? null },
      );
    },
  };
}

export const codexAdapter: AgentAdapter = createCodexAdapter();
export default codexAdapter;
