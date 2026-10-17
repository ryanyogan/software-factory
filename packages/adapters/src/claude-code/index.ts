import { randomUUID } from 'node:crypto';
import type {
  Options,
  PermissionMode,
  query as queryFn,
  SDKUserMessage,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { resolveBinary } from '../binaries';
import { Channel } from '../channel';
import { buildAgentEnv } from '../env';
import { errorMessage, SessionState } from '../session';
import type { AgentAdapter, AgentSession, StartAgentOptions } from '../types';
import { createClaudeMapper } from './map';
import { createPathGuard } from './permissions';

export { createClaudeMapper, type ClaudeMapper, type ClaudeMapperOptions } from './map';
export { createPathGuard } from './permissions';

export interface ClaudeCodeStartOptions extends StartAgentOptions {
  /** Prior session total when resuming (see `ClaudeMapperOptions.costBaseUsd`). */
  costBaseUsd?: number;
  /** Default `acceptEdits` (+ the cwd path guard as `canUseTool`). */
  permissionMode?: PermissionMode;
  /** Default `['project', 'local']`: repo CLAUDE.md + settings, not the user's global hooks/statusline. */
  settingSources?: SettingSource[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export interface ClaudeCodeDeps {
  /** Test seam: replaces `import('@anthropic-ai/claude-agent-sdk')`. */
  loadSdk?: () => Promise<{ query: typeof queryFn }>;
}

function userMessage(text: string, uuid: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    uuid: uuid as SDKUserMessage['uuid'],
  };
}

/** Build the SDK options for one run (exported for tests). */
export function claudeOptions(
  opts: ClaudeCodeStartOptions,
  abortController: AbortController,
): Options {
  const env = buildAgentEnv({
    base: opts.env,
    allowApiKeys: opts.allowApiKeys,
    extra: { CLAUDE_AGENT_SDK_CLIENT_APP: 'sf', ...opts.extraEnv },
  });
  const exe = resolveBinary(opts.binary, 'claude', env.PATH);
  const roots = [opts.cwd, ...(opts.additionalDirectories ?? [])];
  return {
    cwd: opts.cwd,
    env,
    abortController,
    permissionMode: opts.permissionMode ?? 'acceptEdits',
    canUseTool: createPathGuard(roots),
    settingSources: opts.settingSources ?? ['project', 'local'],
    ...(opts.additionalDirectories?.length
      ? { additionalDirectories: opts.additionalDirectories }
      : {}),
    ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
    ...(opts.onStderr ? { stderr: opts.onStderr } : {}),
  };
}

/**
 * Claude Code via `@anthropic-ai/claude-agent-sdk` in streaming-input mode: one long-lived CLI
 * process per session; `send()` streams a user message into it (Claude may fold it into the
 * running turn between tool calls, or run it as the next turn). One `result` per turn →
 * `turn.completed`. `cancel()` aborts the process; `end()` closes the input so the CLI exits once
 * idle. The SDK is imported lazily so bundles that never start Claude never load it.
 */
export function createClaudeCodeAdapter(deps: ClaudeCodeDeps = {}): AgentAdapter {
  return {
    name: 'claude-code',
    async start(input: StartAgentOptions): Promise<AgentSession> {
      const opts = input as ClaudeCodeStartOptions;
      if (!opts.prompt.trim()) throw new Error('prompt is empty');
      const { query } = await (deps.loadSdk ?? (() => import('@anthropic-ai/claude-agent-sdk')))();

      const state = new SessionState(null);
      const map = createClaudeMapper({ costBaseUsd: opts.costBaseUsd });
      const abort = new AbortController();
      const inbox = new Channel<SDKUserMessage>();
      /** Sent message uuids not yet answered by a `result` (idle = none left). */
      const unanswered = new Set<string>();
      let inputEnded = false;

      const push = (text: string) => {
        const uuid = randomUUID();
        unanswered.add(uuid);
        inbox.push(userMessage(text, uuid));
      };
      push(opts.prompt);

      const cancel = () => {
        if (state.finished || state.cancelled) return;
        state.cancelled = true;
        inputEnded = true;
        inbox.clear();
        inbox.close();
        abort.abort();
      };
      if (opts.signal?.aborted) cancel();
      opts.signal?.addEventListener('abort', cancel, { once: true });

      const q = query({ prompt: inbox, options: claudeOptions(opts, abort) });

      void (async () => {
        try {
          for await (const msg of q) {
            if (msg.type === 'result') {
              const answered =
                msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : null);
              if (answered) for (const id of answered) unanswered.delete(id);
              else if ((msg.queued_turn_count ?? 0) === 0) unanswered.clear();
            }
            for (const ev of map(msg)) state.emit(ev);
            if (state.cancelled) break;
          }
        } catch (e) {
          if (!state.cancelled)
            state.emit({ type: 'error', message: errorMessage(e), fatal: true });
        } finally {
          opts.signal?.removeEventListener('abort', cancel);
          if (state.cancelled) {
            try {
              q.close();
            } catch {
              // already gone
            }
          }
          unanswered.clear();
          state.finish();
        }
      })();

      return {
        agent: 'claude-code',
        events: state.events,
        get sessionId() {
          return state.sessionId;
        },
        get idle() {
          return unanswered.size === 0;
        },
        send(text: string) {
          if (inputEnded || state.finished) throw new Error('claude-code session is closed');
          if (!text.trim()) throw new Error('follow-up text is empty');
          push(text);
        },
        end() {
          if (inputEnded) return;
          inputEnded = true;
          inbox.close();
        },
        cancel,
        result: state.result,
      };
    },
  };
}

export const claudeCodeAdapter: AgentAdapter = createClaudeCodeAdapter();
export default claudeCodeAdapter;
