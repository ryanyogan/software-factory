import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { AgentEvent } from '@sf/contract';
import { capOutput } from '../session';

function mcpOutput(item: Extract<ThreadItem, { type: 'mcp_tool_call' }>): string {
  if (item.error) return item.error.message;
  const content = item.result?.content ?? [];
  const text = content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
  return (
    text ||
    (item.result?.structured_content !== undefined
      ? JSON.stringify(item.result.structured_content)
      : '')
  );
}

export interface CodexUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface CodexMapperOptions {
  /**
   * Thread token totals already counted. Codex `turn.completed.usage` is CUMULATIVE for the thread
   * (verified live, codex 0.163.0, and it continues across `resume`), so the mapper emits deltas;
   * on resume pass the earlier totals or the first turn's delta includes the whole history.
   */
  usageBase?: CodexUsageTotals;
}

/**
 * Stateful ThreadEvent → AgentEvent mapper (research §3). `item.updated` is ignored except for todo
 * lists; a tool item seen only on `item.completed` gets its `tool.call` emitted then. Codex reports
 * no cost, so `turn.completed.usage.costUsd` stays undefined.
 */
export function createCodexMapper(options: CodexMapperOptions = {}) {
  let threadId: string | null = null;
  let last: CodexUsageTotals = options.usageBase ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };
  const delta = (now: number, before: number) => (now >= before ? now - before : now);
  const started = new Set<string>();

  const call = (item: ThreadItem): AgentEvent | null => {
    switch (item.type) {
      case 'command_execution':
        return { type: 'tool.call', id: item.id, name: 'shell', input: { command: item.command } };
      case 'mcp_tool_call':
        return {
          type: 'tool.call',
          id: item.id,
          name: `${item.server}.${item.tool}`,
          input: item.arguments,
        };
      case 'web_search':
        return { type: 'tool.call', id: item.id, name: 'web_search', input: { query: item.query } };
      default:
        return null;
    }
  };

  const todo = (item: Extract<ThreadItem, { type: 'todo_list' }>): AgentEvent => ({
    type: 'todo',
    items: item.items.map((t) => ({ text: t.text, done: t.completed })),
  });

  return function map(ev: ThreadEvent): AgentEvent[] {
    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id === threadId) return [];
        threadId = ev.thread_id;
        return [{ type: 'session.started', sessionId: ev.thread_id }];
      case 'turn.started':
        return [];
      case 'turn.completed': {
        const u = ev.usage;
        const now = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cachedInputTokens: u.cached_input_tokens,
        };
        const usage = {
          inputTokens: delta(now.inputTokens, last.inputTokens),
          outputTokens: delta(now.outputTokens, last.outputTokens),
          cachedInputTokens: delta(now.cachedInputTokens, last.cachedInputTokens),
        };
        last = now;
        return [{ type: 'turn.completed', isError: false, usage }];
      }
      case 'turn.failed':
        return [
          { type: 'error', message: ev.error.message, fatal: false },
          { type: 'turn.completed', isError: true, result: ev.error.message },
        ];
      case 'error':
        return [{ type: 'error', message: ev.message, fatal: false }];
      case 'item.started': {
        if (ev.item.type === 'todo_list') return [todo(ev.item)];
        const c = call(ev.item);
        if (!c) return [];
        started.add(ev.item.id);
        return [c];
      }
      case 'item.updated':
        return ev.item.type === 'todo_list' ? [todo(ev.item)] : [];
      case 'item.completed': {
        const item = ev.item;
        const out: AgentEvent[] = [];
        if (!started.has(item.id)) {
          const c = call(item);
          if (c) out.push(c);
        }
        started.delete(item.id);
        switch (item.type) {
          case 'agent_message':
            if (item.text)
              out.push({ type: 'message', role: 'assistant', text: item.text, itemId: item.id });
            break;
          case 'reasoning':
            if (item.text) out.push({ type: 'reasoning', text: item.text });
            break;
          case 'command_execution':
            out.push({
              type: 'tool.result',
              id: item.id,
              isError:
                item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0),
              ...capOutput(item.aggregated_output),
            });
            break;
          case 'mcp_tool_call':
            out.push({
              type: 'tool.result',
              id: item.id,
              isError: item.status === 'failed' || item.error !== undefined,
              ...capOutput(mcpOutput(item)),
            });
            break;
          case 'web_search':
            out.push({ type: 'tool.result', id: item.id, isError: false, output: '' });
            break;
          case 'file_change':
            if (item.status === 'completed') {
              out.push({
                type: 'file.change',
                changes: item.changes.map((c) => ({ path: c.path, kind: c.kind })),
              });
            } else {
              out.push({
                type: 'error',
                message: `file change failed: ${item.changes.map((c) => c.path).join(', ')}`,
                fatal: false,
              });
            }
            break;
          case 'todo_list':
            out.push(todo(item));
            break;
          case 'error':
            out.push({ type: 'error', message: item.message, fatal: false });
            break;
        }
        return out;
      }
      default:
        return [];
    }
  };
}

export type CodexMapper = ReturnType<typeof createCodexMapper>;
