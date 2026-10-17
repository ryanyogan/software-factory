// Maps the raw SDK messages recorded by the stage-9 smoke runs (scripts/smoke.ts --record).
import { readFileSync } from 'node:fs';
import { AgentEvent } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import { createClaudeMapper } from './claude-code/map';
import { createCodexMapper } from './codex/map';

type Row = { phase: 'run1' | 'resume'; t: number; msg: never };
const rows = (agent: string): Row[] =>
  readFileSync(new URL(`../fixtures/${agent}/smoke.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Row);

const summary = (events: AgentEvent[]) =>
  events.map((e) =>
    e.type === 'file.change'
      ? `file.change:${e.changes.map((c) => c.path.split('/').pop()).join(',')}`
      : e.type,
  );

describe('recorded claude-code smoke run', () => {
  const all = rows('claude-code');

  it('run 1: mid-turn follow-up folded into one turn, one result, both files', () => {
    const map = createClaudeMapper();
    const events = all.filter((r) => r.phase === 'run1').flatMap((r) => map(r.msg));
    for (const e of events) expect(AgentEvent.parse(e)).toEqual(e);
    expect(summary(events)).toEqual([
      'session.started',
      'tool.call',
      'tool.result',
      'file.change:hello.txt',
      'tool.call',
      'tool.result',
      'file.change:bye.txt',
      'message',
      'turn.completed',
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'turn.completed', isError: false });
    expect(done?.type === 'turn.completed' && done.usage?.costUsd).toBeCloseTo(0.18298, 4);
  });

  it('resume: same session id; total_cost_usd continues from the transcript → costBaseUsd', () => {
    const map = createClaudeMapper({ costBaseUsd: 0.18298149999999996 });
    const events = all.filter((r) => r.phase === 'resume').flatMap((r) => map(r.msg));
    expect(events[0]).toMatchObject({
      type: 'session.started',
      sessionId: '8b8b0e01-4df1-458d-9383-3c729e13321f',
    });
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'turn.completed', result: 'ok' });
    expect(done?.type === 'turn.completed' && done.usage?.costUsd).toBeCloseTo(0.01163, 4);
  });
});

describe('recorded codex smoke run', () => {
  const all = rows('codex');

  it('run 1: follow-up queued as a second turn; usage deltas from cumulative totals', () => {
    const map = createCodexMapper();
    const events = all.filter((r) => r.phase === 'run1').flatMap((r) => map(r.msg));
    for (const e of events) expect(AgentEvent.parse(e)).toEqual(e);
    const turns = events.filter((e) => e.type === 'turn.completed');
    expect(turns).toEqual([
      {
        type: 'turn.completed',
        isError: false,
        usage: { inputTokens: 40012, outputTokens: 63, cachedInputTokens: 32000 },
      },
      {
        type: 'turn.completed',
        isError: false,
        usage: { inputTokens: 40287, outputTokens: 63, cachedInputTokens: 39808 },
      },
    ]);
    expect(events.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(
      events.filter((e) => e.type === 'tool.call').map((e) => e.type === 'tool.call' && e.name),
    ).toEqual(['shell', 'shell']);
  });

  it('resume: thread totals continue → usageBase', () => {
    const map = createCodexMapper({
      usageBase: { inputTokens: 80299, outputTokens: 126, cachedInputTokens: 71808 },
    });
    const events = all.filter((r) => r.phase === 'resume').flatMap((r) => map(r.msg));
    expect(events.at(-1)).toEqual({
      type: 'turn.completed',
      isError: false,
      usage: { inputTokens: 20230, outputTokens: 5, cachedInputTokens: 19968 },
    });
  });
});
