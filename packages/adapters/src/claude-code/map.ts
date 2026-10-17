import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@sf/contract';
import { capOutput } from '../session';

/** Tools whose successful result means a file in the worktree changed. */
const EDIT_TOOLS: Record<string, 'add' | 'update'> = {
  Write: 'add',
  Edit: 'update',
  MultiEdit: 'update',
  NotebookEdit: 'update',
};

type Block = { type: string; [k: string]: unknown };

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocks(content)
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : `[${b.type}]`))
    .join('\n');
}

export interface ClaudeMapperOptions {
  /**
   * Session cost already counted before this query() call. On resume the SDK's `total_cost_usd`
   * continues from the transcript's saved total, so pass that total to avoid re-counting it.
   */
  costBaseUsd?: number;
}

/**
 * Stateful SDKMessage → AgentEvent mapper (research §3). Skips subagent traffic
 * (`parent_tool_use_id !== null`), replays/echoes of our own input, and every message kind the
 * contract has no event for (status, hooks, stream_event, rate limits, ...).
 */
export function createClaudeMapper(options: ClaudeMapperOptions = {}) {
  let lastTotalCost = options.costBaseUsd ?? 0;
  let sessionId: string | null = null;
  const pendingEdits = new Map<string, { path: string; kind: 'add' | 'update' }>();

  return function map(msg: SDKMessage): AgentEvent[] {
    const out: AgentEvent[] = [];
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init' && msg.session_id !== sessionId) {
          sessionId = msg.session_id;
          out.push({
            type: 'session.started',
            sessionId: msg.session_id,
            model: msg.model,
            cwd: msg.cwd,
          });
        }
        break;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id !== null) break;
        for (const b of blocks(msg.message.content)) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
            out.push({ type: 'message', role: 'assistant', text: b.text, itemId: msg.message.id });
          } else if (
            b.type === 'thinking' &&
            typeof b.thinking === 'string' &&
            b.thinking.length > 0
          ) {
            out.push({ type: 'reasoning', text: b.thinking });
          } else if (
            b.type === 'tool_use' &&
            typeof b.id === 'string' &&
            typeof b.name === 'string'
          ) {
            out.push({ type: 'tool.call', id: b.id, name: b.name, input: b.input });
            const input = (b.input ?? {}) as Record<string, unknown>;
            const kind = EDIT_TOOLS[b.name];
            const path = input.file_path ?? input.notebook_path;
            if (kind && typeof path === 'string') pendingEdits.set(b.id, { path, kind });
            if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
              out.push({
                type: 'todo',
                items: (input.todos as { content?: unknown; status?: unknown }[]).map((t) => ({
                  text: typeof t.content === 'string' ? t.content : '',
                  done: t.status === 'completed',
                })),
              });
            }
          }
        }
        if (msg.error)
          out.push({ type: 'error', message: `assistant error: ${msg.error}`, fatal: false });
        break;
      }
      case 'user': {
        if (msg.parent_tool_use_id !== null || ('isReplay' in msg && msg.isReplay)) break;
        for (const b of blocks(msg.message.content)) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const isError = b.is_error === true;
          out.push({
            type: 'tool.result',
            id: b.tool_use_id,
            isError,
            ...capOutput(toolResultText(b.content)),
          });
          const edit = pendingEdits.get(b.tool_use_id);
          if (edit) {
            pendingEdits.delete(b.tool_use_id);
            if (!isError) out.push({ type: 'file.change', changes: [edit] });
          }
        }
        break;
      }
      case 'result': {
        // total_cost_usd is cumulative for the query() call (running total per result): emit deltas.
        const total = msg.total_cost_usd;
        const costUsd = total >= lastTotalCost ? total - lastTotalCost : total;
        lastTotalCost = total;
        const u = msg.usage;
        const cached = u.cache_read_input_tokens ?? 0;
        const isError = msg.is_error || msg.subtype !== 'success';
        if (msg.subtype !== 'success') {
          out.push({
            type: 'error',
            message: msg.errors.length > 0 ? msg.errors.join('\n') : msg.subtype,
            fatal: false,
          });
        }
        out.push({
          type: 'turn.completed',
          usage: {
            // usage is per-turn in streaming-input sessions (main loop only).
            inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cached,
            outputTokens: u.output_tokens,
            cachedInputTokens: cached,
            costUsd: Math.max(0, costUsd),
          },
          isError,
          ...(msg.subtype === 'success' ? { result: msg.result } : {}),
        });
        break;
      }
      default:
        break;
    }
    return out;
  };
}

export type ClaudeMapper = ReturnType<typeof createClaudeMapper>;
