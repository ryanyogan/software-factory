import type {
  Options,
  query as queryFn,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import type { AgentSession } from '../types';
import * as fx from './fixtures';
import { createClaudeCodeAdapter } from './index';

/** Stand-in for the SDK's query(): one turn per streamed user message, cumulative cost +0.1/turn. */
function fakeSdk(behaviour: { throwOn?: string } = {}) {
  const seen = {
    options: undefined as Options | undefined,
    received: [] as SDKUserMessage[],
    closed: false,
  };
  const query = (({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }) => {
    seen.options = options;
    const signal = options.abortController!.signal;
    const gen = (async function* (): AsyncGenerator<SDKMessage> {
      let total = 0;
      for await (const u of prompt) {
        seen.received.push(u);
        const text = typeof u.message.content === 'string' ? u.message.content : '';
        if (seen.received.length === 1) yield fx.init;
        if (text === behaviour.throwOn) throw new Error('CLI exited with code 1');
        if (text === 'hang') {
          await new Promise((_, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          session_id: 'sess-1',
          message: {
            id: `m${seen.received.length}`,
            content: [{ type: 'text', text: `re: ${text}` }],
          },
        } as unknown as SDKMessage;
        total += 0.1;
        yield fx.result(total, { user_message_uuids: [u.uuid] });
      }
    })();
    return Object.assign(gen, { close: () => (seen.closed = true) });
  }) as unknown as typeof queryFn;
  return { seen, adapter: createClaudeCodeAdapter({ loadSdk: async () => ({ query }) }) };
}

async function take(s: AgentSession, until: (e: AgentEvent) => boolean): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const it = s.events[Symbol.asyncIterator]();
  for (;;) {
    const r = await it.next();
    if (r.done) return out;
    out.push(r.value);
    if (until(r.value)) return out;
  }
}
const turnDone = (e: AgentEvent) => e.type === 'turn.completed';

describe('claude-code adapter', () => {
  it('builds unattended, cwd-scoped SDK options from the full env minus ANTHROPIC_API_KEY', async () => {
    const { seen, adapter } = fakeSdk();
    const s = await adapter.start({
      cwd: '/w',
      prompt: 'hi',
      resumeSessionId: 'old-sess',
      binary: '/opt/claude',
      env: { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-secret' },
    });
    await take(s, turnDone);
    const o = seen.options!;
    expect(o).toMatchObject({
      cwd: '/w',
      permissionMode: 'acceptEdits',
      settingSources: ['project', 'local'],
      resume: 'old-sess',
      pathToClaudeCodeExecutable: '/opt/claude',
    });
    expect(o.env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_AGENT_SDK_CLIENT_APP: 'sf' });
    expect(typeof o.canUseTool).toBe('function');
    expect(seen.received[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    });
    s.cancel();
    await s.result;
  });

  it('streams follow-ups into the live session; per-turn cost deltas; end() finishes', async () => {
    const { seen, adapter } = fakeSdk();
    const s = await adapter.start({ cwd: '/w', prompt: 'first', binary: 'bundled', env: {} });
    expect(s.idle).toBe(false);
    const t1 = await take(s, turnDone);
    expect(t1.map((e) => e.type)).toEqual(['session.started', 'message', 'turn.completed']);
    expect(s.idle).toBe(true);
    expect(s.sessionId).toBe('sess-1');
    expect(seen.options).not.toHaveProperty('pathToClaudeCodeExecutable');

    s.send('second');
    expect(s.idle).toBe(false);
    const t2 = await take(s, turnDone);
    expect(t2[0]).toEqual({ type: 'message', role: 'assistant', text: 're: second', itemId: 'm2' });
    expect(t2[1]).toMatchObject({
      type: 'turn.completed',
      usage: { costUsd: expect.closeTo(0.1) },
    });
    expect(s.idle).toBe(true);

    s.end();
    expect(() => s.send('late')).toThrow(/closed/);
    expect(await take(s, () => false)).toEqual([]);
    const r = await s.result;
    expect(r).toMatchObject({ ok: true, cancelled: false, sessionId: 'sess-1', turns: 2 });
    expect(r.costUsd).toBeCloseTo(0.2);
    expect(r.usage).toEqual({ inputTokens: 230, outputTokens: 40, cachedInputTokens: 200 });
  });

  it('cancel() mid-turn aborts and closes the query', async () => {
    const { seen, adapter } = fakeSdk();
    const s = await adapter.start({ cwd: '/w', prompt: 'hang', env: {} });
    await take(s, (e) => e.type === 'session.started');
    s.cancel();
    s.cancel();
    const r = await s.result;
    expect(r).toMatchObject({ ok: false, cancelled: true, turns: 0 });
    expect(r.error).toBeUndefined();
    expect(seen.options!.abortController!.signal.aborted).toBe(true);
    expect(seen.closed).toBe(true);
    expect(() => s.send('x')).toThrow(/closed/);
  });

  it('an aborted external signal cancels', async () => {
    const { adapter } = fakeSdk();
    const ac = new AbortController();
    const s = await adapter.start({ cwd: '/w', prompt: 'hang', env: {}, signal: ac.signal });
    await take(s, (e) => e.type === 'session.started');
    ac.abort();
    expect(await s.result).toMatchObject({ cancelled: true });
  });

  it('an SDK failure is a fatal error event and a failed result', async () => {
    const { adapter } = fakeSdk({ throwOn: 'boom' });
    const s = await adapter.start({ cwd: '/w', prompt: 'boom', env: {} });
    const events = await take(s, () => false);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'CLI exited with code 1',
      fatal: true,
    });
    expect(await s.result).toMatchObject({
      ok: false,
      cancelled: false,
      error: 'CLI exited with code 1',
    });
  });

  it('rejects an empty prompt', async () => {
    await expect(fakeSdk().adapter.start({ cwd: '/w', prompt: '  ' })).rejects.toThrow(/empty/);
  });
});
