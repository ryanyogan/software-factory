import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTurnSession } from '../session';
import type { AgentAdapter, AgentSession, StartAgentOptions } from '../types';
import { fill, loadFakeScript, type FakeScriptInput, type FakeTurn } from './script';

export * from './script';

export interface FakeStartOptions extends StartAgentOptions {
  /** Script object; else `SF_FAKE_SCRIPT` from `env` (JSON or file path); else `defaultFakeScript`. */
  fakeScript?: FakeScriptInput;
}

/**
 * Scripted agent with Codex-like semantics (turn-based; follow-ups queue and run as the next turn,
 * joined if several are queued). Deterministic apart from the generated session id. Writes real
 * files in cwd so diffs appear. Spends nothing.
 */
export function createFakeAdapter(): AgentAdapter {
  return {
    name: 'fake',
    async start(input: StartAgentOptions): Promise<AgentSession> {
      const opts = input as FakeStartOptions;
      if (!opts.prompt.trim()) throw new Error('prompt is empty');
      const script = loadFakeScript(opts.fakeScript, opts.env ?? process.env);
      const sessionId = script.sessionId ?? opts.resumeSessionId ?? `fake-${randomUUID()}`;
      const cwd = resolve(opts.cwd);
      const empty: FakeTurn = { steps: [], costUsd: 0 };

      return createTurnSession(
        'fake',
        async (prompt, { signal, turn, emit }) => {
          const spec = script.turns?.[turn - 1] ?? script.followUp ?? empty;
          const vars = { prompt, turn };
          const t = (s: string, extra: Record<string, string | number> = {}) =>
            fill(s, { ...vars, ...extra });
          let outputChars = 0;
          let calls = 0;
          const pause = async (ms: number) => {
            if (ms > 0) await sleep(ms, undefined, { signal });
            signal.throwIfAborted();
          };

          if (turn === 1) emit({ type: 'session.started', sessionId, model: 'fake', cwd });
          for (const step of spec.steps) {
            await pause(script.stepDelayMs);
            switch (step.type) {
              case 'message': {
                const text = t(step.text);
                outputChars += text.length;
                emit({ type: 'message', role: 'assistant', text });
                break;
              }
              case 'reasoning':
                emit({ type: 'reasoning', text: t(step.text) });
                break;
              case 'write': {
                const rel = t(step.path);
                const abs = resolve(cwd, rel);
                const r = relative(cwd, abs);
                if (!r || r.startsWith('..') || isAbsolute(r))
                  throw new Error(`fake write outside cwd: ${rel}`);
                const id = `fake_${turn}_${++calls}`;
                const kind = existsSync(abs) ? 'update' : 'add';
                const content = t(step.content);
                emit({ type: 'tool.call', id, name: 'Write', input: { file_path: abs, content } });
                await mkdir(dirname(abs), { recursive: true });
                await writeFile(abs, content);
                emit({ type: 'tool.result', id, output: `Wrote ${r}`, isError: false });
                emit({ type: 'file.change', changes: [{ path: r, kind }] });
                break;
              }
              case 'tool': {
                const id = `fake_${turn}_${++calls}`;
                emit({ type: 'tool.call', id, name: step.name, input: step.input ?? {} });
                emit({ type: 'tool.result', id, output: t(step.output), isError: step.isError });
                break;
              }
              case 'todo':
                emit({
                  type: 'todo',
                  items: step.items.map((i) => ({ text: t(i.text), done: i.done })),
                });
                break;
              case 'sleep':
                await pause(step.ms);
                break;
              case 'burst':
                for (let i = 1; i <= step.count; i++) {
                  if (i > 1) await pause(step.intervalMs);
                  const text = t(step.text, { i });
                  outputChars += text.length;
                  emit({ type: 'message', role: 'assistant', text });
                }
                break;
              case 'error':
                emit({ type: 'error', message: t(step.message), fatal: step.fatal });
                break;
              case 'fail':
                throw new Error(t(step.message));
            }
          }
          signal.throwIfAborted();
          emit({
            type: 'turn.completed',
            isError: false,
            usage: {
              inputTokens: prompt.length,
              outputTokens: outputChars,
              cachedInputTokens: 0,
              costUsd: spec.costUsd,
            },
            ...(spec.result !== undefined ? { result: t(spec.result) } : {}),
          });
        },
        { prompt: opts.prompt, signal: opts.signal, sessionId: opts.resumeSessionId ?? null },
      );
    },
  };
}

export const fakeAdapter: AgentAdapter = createFakeAdapter();
export default fakeAdapter;
