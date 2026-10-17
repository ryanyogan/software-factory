// Hand-written SDKMessage fixtures (shapes from sdk.d.ts 0.3.302); only fields the mapper reads +
// required discriminants. Recorded smoke-run messages live in ../../fixtures/claude-code/*.jsonl.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const S = 'sess-1';
const m = (x: unknown) => x as SDKMessage;

export const init = m({
  type: 'system',
  subtype: 'init',
  session_id: S,
  uuid: 'u0',
  cwd: '/w',
  model: 'claude-opus-5-5',
  tools: ['Write', 'Bash'],
  permissionMode: 'acceptEdits',
  apiKeySource: 'none',
  claude_code_version: '2.1.302',
  mcp_servers: [],
  slash_commands: [],
});

export const assistant = m({
  type: 'assistant',
  parent_tool_use_id: null,
  session_id: S,
  uuid: 'u1',
  message: {
    id: 'msg_1',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: 'plan it' },
      { type: 'text', text: 'Creating hello.txt' },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'Write',
        input: { file_path: '/w/hello.txt', content: 'hi' },
      },
      { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } },
      {
        type: 'tool_use',
        id: 'tu_3',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'a', status: 'completed' },
            { content: 'b', status: 'pending' },
          ],
        },
      },
    ],
  },
});

export const toolResults = m({
  type: 'user',
  parent_tool_use_id: null,
  session_id: S,
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'File created' },
      {
        type: 'tool_result',
        tool_use_id: 'tu_2',
        content: [{ type: 'text', text: 'a\nb' }],
        is_error: true,
      },
    ],
  },
});

export const subagent = m({
  type: 'assistant',
  parent_tool_use_id: 'tu_task',
  session_id: S,
  uuid: 'u2',
  message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'sub' }] },
});

export const replay = m({
  type: 'user',
  isReplay: true,
  parent_tool_use_id: null,
  session_id: S,
  uuid: 'u3',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'old' }] },
});

const usage = (input: number, output: number, cacheRead = 0, cacheCreate = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
});

export const result = (totalCost: number, extra: Record<string, unknown> = {}) =>
  m({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    num_turns: 2,
    duration_ms: 10,
    duration_api_ms: 9,
    stop_reason: 'end_turn',
    total_cost_usd: totalCost,
    usage: usage(10, 20, 100, 5),
    modelUsage: {},
    permission_denials: [],
    session_id: S,
    uuid: 'r',
    ...extra,
  });

export const errorResult = m({
  type: 'result',
  subtype: 'error_max_turns',
  is_error: true,
  errors: ['hit max turns'],
  num_turns: 3,
  duration_ms: 1,
  duration_api_ms: 1,
  stop_reason: null,
  total_cost_usd: 0.5,
  usage: usage(1, 1),
  modelUsage: {},
  permission_denials: [],
  session_id: S,
  uuid: 'r2',
});
