import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEvent } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import { loadAdapter, startAgent } from '../index';
import type { AgentSession } from '../types';
import { FAKE_SCRIPT_ENV } from './script';

const tmp = () => mkdtempSync(join(tmpdir(), 'sf-fake-'));

async function take(s: AgentSession, until: (e: AgentEvent) => boolean): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const it = s.events[Symbol.asyncIterator]();
  for (;;) {
    const r = await it.next();
    if (r.done) return out;
    expect(AgentEvent.parse(r.value)).toEqual(r.value);
    out.push(r.value);
    if (until(r.value)) return out;
  }
}
const turnDone = (e: AgentEvent) => e.type === 'turn.completed';

describe('fake adapter', () => {
  it('default script: writes a file per turn, answers follow-ups, ends cleanly', async () => {
    const cwd = tmp();
    const s = await startAgent({ agent: 'fake', cwd, prompt: 'add login', env: {} });
    expect(s.agent).toBe('fake');
    const t1 = await take(s, turnDone);
    expect(t1.map((e) => e.type)).toEqual([
      'session.started',
      'message',
      'tool.call',
      'tool.result',
      'file.change',
      'message',
      'turn.completed',
    ]);
    expect(t1[1]).toMatchObject({ text: 'Working on: add login' });
    expect(t1[4]).toEqual({
      type: 'file.change',
      changes: [{ path: 'sf-fake-turn-1.md', kind: 'add' }],
    });
    expect(readFileSync(join(cwd, 'sf-fake-turn-1.md'), 'utf8')).toBe('# Turn 1\n\nadd login\n');
    expect(s.idle).toBe(true);

    s.send('also tests');
    const t2 = await take(s, turnDone);
    expect(t2[0]).toMatchObject({ type: 'message', text: 'Follow-up received: also tests' });
    expect(existsSync(join(cwd, 'sf-fake-turn-2.md'))).toBe(true);

    s.end();
    const r = await s.result;
    expect(r).toMatchObject({ ok: true, cancelled: false, turns: 2, sessionId: s.sessionId });
    expect(r.sessionId).toMatch(/^fake-/);
    expect(r.costUsd).toBeCloseTo(0.02);
  });

  it('cancel() stops a sleeping turn; nothing after it is written', async () => {
    const cwd = tmp();
    const s = await startAgent({
      agent: 'fake',
      cwd,
      prompt: 'p',
      fakeScript: {
        turns: [
          {
            steps: [
              { type: 'message', text: 'go' },
              { type: 'sleep', ms: 10_000 },
              { type: 'write', path: 'late.txt', content: 'x' },
            ],
          },
        ],
      },
    });
    await take(s, (e) => e.type === 'message');
    const t0 = Date.now();
    s.cancel();
    const r = await s.result;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ ok: false, cancelled: true, turns: 0 });
    expect(existsSync(join(cwd, 'late.txt'))).toBe(false);
    expect(await take(s, () => false)).toEqual([]);
  });

  it('reads the script from SF_FAKE_SCRIPT (file path), supports burst, fail, fatal, resume id', async () => {
    const cwd = tmp();
    const scriptPath = join(cwd, 'script.json');
    writeFileSync(
      scriptPath,
      JSON.stringify({
        sessionId: 'fixed',
        turns: [
          { steps: [{ type: 'burst', count: 3, text: 'm{{i}} of turn {{turn}}' }], costUsd: 0 },
          { steps: [{ type: 'fail', message: 'nope: {{prompt}}' }] },
        ],
        followUp: { steps: [{ type: 'error', message: 'dead', fatal: true }] },
      }),
    );
    const adapter = await loadAdapter('fake');
    const s = await adapter.start({
      cwd,
      prompt: 'go',
      resumeSessionId: 'ignored',
      env: { [FAKE_SCRIPT_ENV]: scriptPath },
    });
    const t1 = await take(s, turnDone);
    expect(
      t1.filter((e) => e.type === 'message').map((e) => e.type === 'message' && e.text),
    ).toEqual(['m1 of turn 1', 'm2 of turn 1', 'm3 of turn 1']);
    s.send('x');
    const t2 = await take(s, turnDone);
    expect(t2).toEqual([
      { type: 'error', message: 'nope: x', fatal: false },
      { type: 'turn.completed', isError: true, result: 'nope: x' },
    ]);
    s.send('y');
    await take(s, () => false); // fatal ends the session
    const r = await s.result;
    expect(r).toMatchObject({
      ok: false,
      cancelled: false,
      sessionId: 'fixed',
      error: 'dead',
      turns: 3,
    });
  });

  it('accepts inline JSON, rejects bad scripts and writes outside cwd', async () => {
    const cwd = tmp();
    const s = await startAgent({
      agent: 'fake',
      cwd,
      prompt: 'p',
      env: {
        [FAKE_SCRIPT_ENV]: JSON.stringify({
          turns: [{ steps: [{ type: 'write', path: '../escape.txt', content: 'x' }] }],
        }),
      },
    });
    const t = await take(s, turnDone);
    expect(t.at(-1)).toMatchObject({ type: 'turn.completed', isError: true });
    s.end();
    await expect(
      startAgent({
        agent: 'fake',
        cwd,
        prompt: 'p',
        env: { [FAKE_SCRIPT_ENV]: '{"turns":[{"steps":[{"type":"nope"}]}]}' },
      }),
    ).rejects.toThrow(/invalid|Invalid/);
    await expect(loadAdapter('opencode')).rejects.toThrow(/no adapter/);
  });
});
