import { AgentEvent, TOOL_OUTPUT_MAX } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import * as fx from './fixtures';
import { createClaudeMapper } from './map';

describe('createClaudeMapper', () => {
  it('maps init, assistant blocks, tool results and file changes', () => {
    const map = createClaudeMapper();
    const events = [fx.init, fx.init, fx.assistant, fx.toolResults].flatMap(map);
    for (const e of events) expect(AgentEvent.parse(e)).toEqual(e);
    expect(events).toEqual([
      { type: 'session.started', sessionId: 'sess-1', model: 'claude-opus-5-5', cwd: '/w' },
      { type: 'reasoning', text: 'plan it' },
      { type: 'message', role: 'assistant', text: 'Creating hello.txt', itemId: 'msg_1' },
      {
        type: 'tool.call',
        id: 'tu_1',
        name: 'Write',
        input: { file_path: '/w/hello.txt', content: 'hi' },
      },
      { type: 'tool.call', id: 'tu_2', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool.call', id: 'tu_3', name: 'TodoWrite', input: expect.anything() },
      {
        type: 'todo',
        items: [
          { text: 'a', done: true },
          { text: 'b', done: false },
        ],
      },
      { type: 'tool.result', id: 'tu_1', output: 'File created', isError: false },
      { type: 'file.change', changes: [{ path: '/w/hello.txt', kind: 'add' }] },
      { type: 'tool.result', id: 'tu_2', output: 'a\nb', isError: true },
    ]);
  });

  it('skips subagent messages, replays and unknown kinds', () => {
    const map = createClaudeMapper();
    expect(map(fx.subagent)).toEqual([]);
    expect(map(fx.replay)).toEqual([]);
    expect(map({ type: 'stream_event' } as never)).toEqual([]);
  });

  it('turns cumulative total_cost_usd into per-turn deltas', () => {
    const map = createClaudeMapper();
    const t1 = map(fx.result(0.1));
    const t2 = map(fx.result(0.25));
    expect(t1).toEqual([
      {
        type: 'turn.completed',
        isError: false,
        result: 'done',
        usage: { inputTokens: 115, outputTokens: 20, cachedInputTokens: 100, costUsd: 0.1 },
      },
    ]);
    expect(t2[0]?.type === 'turn.completed' && t2[0].usage?.costUsd).toBeCloseTo(0.15);
  });

  it('subtracts a resume cost base and resets after a total drop', () => {
    const map = createClaudeMapper({ costBaseUsd: 1 });
    const cost = (e: AgentEvent[]) => (e[0]?.type === 'turn.completed' ? e[0].usage?.costUsd : NaN);
    expect(cost(map(fx.result(1.2)))).toBeCloseTo(0.2);
    expect(cost(map(fx.result(0.05)))).toBeCloseTo(0.05);
  });

  it('maps error results to error + failed turn', () => {
    const events = createClaudeMapper()(fx.errorResult);
    expect(events).toEqual([
      { type: 'error', message: 'hit max turns', fatal: false },
      expect.objectContaining({ type: 'turn.completed', isError: true }),
    ]);
  });

  it('caps long tool output', () => {
    const map = createClaudeMapper();
    const [e] = map({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(TOOL_OUTPUT_MAX + 5) },
        ],
      },
    } as never);
    expect(e).toMatchObject({ type: 'tool.result', truncated: true });
    expect(AgentEvent.safeParse(e).success).toBe(true);
  });
});
