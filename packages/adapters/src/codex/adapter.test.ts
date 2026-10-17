import type { CodexOptions, ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import type { AgentEvent } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import type { AgentSession } from '../types';
import { createCodexAdapter, type CodexLike, type CodexThreadLike } from './index';

const usage = {
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 2,
  reasoning_output_tokens: 0,
};

/** Stand-in Codex: each runStreamed = one turn; `hang` waits for abort; `fail` exits non-zero after turn.failed. */
function fakeCodex() {
  const seen = {
    codex: undefined as CodexOptions | undefined,
    thread: undefined as ThreadOptions | undefined,
    resumed: null as string | null,
    inputs: [] as string[],
    signals: [] as (AbortSignal | undefined)[],
  };
  const thread: CodexThreadLike = {
    id: 'th_1',
    async runStreamed(input: string, t?: TurnOptions) {
      seen.inputs.push(input);
      seen.signals.push(t?.signal);
      const events = (async function* (): AsyncGenerator<ThreadEvent> {
        yield { type: 'thread.started', thread_id: 'th_1' };
        yield { type: 'turn.started' };
        if (input === 'hang') {
          await new Promise((_, reject) => {
            if (t?.signal?.aborted) reject(new Error('aborted'));
            t?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        if (input === 'fail') {
          yield { type: 'turn.failed', error: { message: 'usage limit' } };
          throw new Error('Codex Exec exited with code 1: usage limit');
        }
        if (input === 'crash') throw new Error('spawn codex ENOENT');
        yield {
          type: 'item.completed',
          item: { id: `m${seen.inputs.length}`, type: 'agent_message', text: `re: ${input}` },
        };
        // Codex usage is thread-cumulative.
        const n = seen.inputs.length;
        yield {
          type: 'turn.completed',
          usage: { ...usage, input_tokens: 10 * n, output_tokens: 2 * n },
        };
      })();
      return { events };
    },
  };
  const codex: CodexLike = {
    startThread: (o) => ((seen.thread = o), thread),
    resumeThread: (id, o) => ((seen.resumed = id), (seen.thread = o), thread),
  };
  return { seen, adapter: createCodexAdapter({ createCodex: (o) => ((seen.codex = o), codex) }) };
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

describe('codex adapter', () => {
  it('uses workspace-write + never-approve in cwd, full env minus API keys, PATH binary', async () => {
    const { seen, adapter } = fakeCodex();
    const s = await adapter.start({
      cwd: '/w',
      prompt: 'hi',
      binary: '/opt/codex',
      env: { PATH: '/bin', OPENAI_API_KEY: 'sk', CODEX_API_KEY: 'c', HOME: '/h' },
    });
    await take(s, turnDone);
    expect(seen.codex).toEqual({
      env: { PATH: '/bin', HOME: '/h' },
      codexPathOverride: '/opt/codex',
    });
    expect(seen.thread).toEqual({
      workingDirectory: '/w',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });
    expect(seen.resumed).toBeNull();
    s.cancel();
  });

  it('queues follow-ups as the next turn on the same thread (joined), then end()', async () => {
    const { seen, adapter } = fakeCodex();
    const s = await adapter.start({ cwd: '/w', prompt: 'hang', env: {}, resumeSessionId: 'th_1' });
    expect(seen.resumed).toBe('th_1');
    expect(s.sessionId).toBe('th_1');
    await take(s, (e) => e.type === 'session.started');
    // first turn is hanging: follow-ups wait
    s.send('a');
    s.send('b');
    expect(s.idle).toBe(false);
    expect(seen.inputs).toEqual(['hang']);
    s.cancel();
    expect(await s.result).toMatchObject({ cancelled: true, ok: false });
    expect(seen.signals[0]?.aborted).toBe(true);
    expect(seen.inputs).toEqual(['hang']); // queued follow-ups dropped on cancel

    const two = fakeCodex();
    const s2 = await two.adapter.start({ cwd: '/w', prompt: 'one', env: {} });
    s2.send('two');
    s2.send('three');
    await take(s2, turnDone);
    const t2 = await take(s2, turnDone);
    expect(two.seen.inputs).toEqual(['one', 'two\n\nthree']);
    expect(t2[0]).toMatchObject({ type: 'message', text: 're: two\n\nthree' });
    expect(s2.idle).toBe(true);
    s2.end();
    const r = await s2.result;
    expect(r).toMatchObject({
      ok: true,
      turns: 2,
      sessionId: 'th_1',
      usage: { inputTokens: 20, outputTokens: 4 },
    });
    expect(r.costUsd).toBeUndefined();
  });

  it('a failed turn is reported once and the session continues', async () => {
    const { adapter } = fakeCodex();
    const s = await adapter.start({ cwd: '/w', prompt: 'fail', env: {} });
    const t1 = await take(s, turnDone);
    expect(t1.slice(1)).toEqual([
      { type: 'error', message: 'usage limit', fatal: false },
      { type: 'turn.completed', isError: true, result: 'usage limit' },
    ]);
    s.send('crash');
    const t2 = await take(s, turnDone);
    expect(t2.slice(-2)).toEqual([
      { type: 'error', message: 'spawn codex ENOENT', fatal: false },
      { type: 'turn.completed', isError: true, result: 'spawn codex ENOENT' },
    ]);
    s.send('ok');
    await take(s, turnDone);
    s.end();
    expect(await s.result).toMatchObject({ ok: true, turns: 3 });
  });
});
