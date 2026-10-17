import type { ThreadEvent } from '@openai/codex-sdk';
import { AgentEvent } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import { createCodexMapper } from './map';

const usage = {
  input_tokens: 100,
  cached_input_tokens: 40,
  cache_write_input_tokens: 0,
  output_tokens: 7,
  reasoning_output_tokens: 3,
};

// Hand-written ThreadEvents (shapes from codex-sdk 0.163.0 index.d.ts).
const turn: ThreadEvent[] = [
  { type: 'thread.started', thread_id: 'th_1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } },
  {
    type: 'item.started',
    item: {
      id: 'i1',
      type: 'command_execution',
      command: 'ls',
      aggregated_output: '',
      status: 'in_progress',
    },
  },
  {
    type: 'item.updated',
    item: {
      id: 'i1',
      type: 'command_execution',
      command: 'ls',
      aggregated_output: 'a',
      status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'i1',
      type: 'command_execution',
      command: 'ls',
      aggregated_output: 'a\n',
      exit_code: 2,
      status: 'completed',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'i2',
      type: 'file_change',
      changes: [{ path: 'hello.txt', kind: 'add' }],
      status: 'completed',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'i3',
      type: 'mcp_tool_call',
      server: 'gh',
      tool: 'pr',
      arguments: { n: 1 },
      result: { content: [{ type: 'text', text: 'ok' }], structured_content: null },
      status: 'completed',
    },
  },
  {
    type: 'item.started',
    item: { id: 'i4', type: 'todo_list', items: [{ text: 'x', completed: false }] },
  },
  { type: 'item.completed', item: { id: 'i5', type: 'web_search', query: 'q' } },
  { type: 'item.completed', item: { id: 'i6', type: 'agent_message', text: 'Created hello.txt' } },
  { type: 'turn.completed', usage },
];

describe('createCodexMapper', () => {
  it('maps a full turn', () => {
    const map = createCodexMapper();
    const events = turn.flatMap(map);
    for (const e of events) expect(AgentEvent.parse(e)).toEqual(e);
    expect(events).toEqual([
      { type: 'session.started', sessionId: 'th_1' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool.call', id: 'i1', name: 'shell', input: { command: 'ls' } },
      { type: 'tool.result', id: 'i1', output: 'a\n', isError: true },
      { type: 'file.change', changes: [{ path: 'hello.txt', kind: 'add' }] },
      { type: 'tool.call', id: 'i3', name: 'gh.pr', input: { n: 1 } },
      { type: 'tool.result', id: 'i3', output: 'ok', isError: false },
      { type: 'todo', items: [{ text: 'x', done: false }] },
      { type: 'tool.call', id: 'i5', name: 'web_search', input: { query: 'q' } },
      { type: 'tool.result', id: 'i5', output: '', isError: false },
      { type: 'message', role: 'assistant', text: 'Created hello.txt', itemId: 'i6' },
      {
        type: 'turn.completed',
        isError: false,
        usage: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 40 },
      },
    ]);
  });

  it('dedupes thread.started on resumed turns and maps failures', () => {
    const map = createCodexMapper();
    map({ type: 'thread.started', thread_id: 'th_1' });
    expect(map({ type: 'thread.started', thread_id: 'th_1' })).toEqual([]);
    expect(map({ type: 'turn.failed', error: { message: 'quota' } })).toEqual([
      { type: 'error', message: 'quota', fatal: false },
      { type: 'turn.completed', isError: true, result: 'quota' },
    ]);
    expect(map({ type: 'error', message: 'stream' })).toEqual([
      { type: 'error', message: 'stream', fatal: false },
    ]);
    expect(
      map({
        type: 'item.completed',
        item: {
          id: 'f',
          type: 'file_change',
          changes: [{ path: 'a', kind: 'update' }],
          status: 'failed',
        },
      }),
    ).toEqual([{ type: 'error', message: 'file change failed: a', fatal: false }]);
  });
});
