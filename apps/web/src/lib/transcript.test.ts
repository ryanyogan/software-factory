import type { Run } from '@sf/contract';
import { describe, expect, it } from 'vite-plus/test';
import {
  type RawRunEvent,
  buildTranscript,
  canCancel,
  mergeEvents,
  messageBlockedReason,
  needsYouReason,
  toolSummary,
} from './transcript';

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  taskId: 'tsk_1',
  agent: 'fake',
  location: 'local',
  state: 'running',
  prompt: 'create hello.md',
  openPr: true,
  createdAt: '2026-10-17T10:00:00.000Z',
  startedBy: 'dev',
  claimedBy: 'mch_a',
  claimedAt: '2026-10-17T10:00:01.000Z',
  sessionId: null,
  prUrl: null,
  costUsd: null,
  endedAt: null,
  ...over,
});

let seq = 0;
const ev = (type: string, payload: unknown): RawRunEvent => ({
  seq: ++seq,
  type,
  payload,
  at: 1_700_000_000_000 + seq,
});
const agent = (payload: unknown) => ev('agent', payload);

const PATCH = [
  'diff --git a/hello.md b/hello.md',
  'new file mode 100644',
  'index 0000000..ce01362',
  '--- /dev/null',
  '+++ b/hello.md',
  '@@ -0,0 +1,2 @@',
  '+# Hello',
  '+',
  '',
].join('\n');

function scenario(): RawRunEvent[] {
  seq = 0;
  return [
    ev('run.started', run({ state: 'queued', claimedBy: null, claimedAt: null })),
    ev('run.claimed', { machineId: 'mch_a', run: run() }),
    ev('run.state', { from: 'queued', to: 'running', run: run() }),
    agent({ type: 'session.started', sessionId: 'fake-1', model: 'fake-model', cwd: '/w' }),
    agent({ type: 'message', role: 'assistant', text: 'Working on: **create** hello.md' }),
    agent({ type: 'tool.call', id: 't1', name: 'Write', input: { file_path: '/w/hello.md' } }),
    ev('user.message', { id: 'msg_1', text: 'also add bye.md', author: { userId: 'dev' } }),
    agent({ type: 'tool.result', id: 't1', output: 'ok', isError: false }),
    agent({ type: 'file.change', changes: [{ path: '/w/hello.md', kind: 'add' }] }),
    agent({
      type: 'turn.completed',
      usage: { inputTokens: 1200, outputTokens: 30, costUsd: 0.01 },
      isError: false,
    }),
    ev('diff.snapshot', {
      turn: 1,
      base: 'abc1234def',
      patch: PATCH,
      stats: { files: 1, additions: 2, deletions: 0 },
    }),
    agent({ type: 'tool.call', id: 't2', name: 'Bash', input: { command: 'ls -la' } }),
    agent({ type: 'tool.result', id: 't2', output: 'boom', isError: true }),
    agent({ type: 'error', message: 'non fatal', fatal: false }),
    agent({ type: 'turn.completed', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 } }),
    ev('diff.snapshot', {
      turn: 2,
      base: 'abc1234def',
      patch: '',
      stats: { files: 9, additions: 9000, deletions: 1 },
      truncated: true,
    }),
    ev('run.state', { from: 'running', to: 'review', run: run({ state: 'review' }) }),
    ev('pr.opened', { url: 'https://github.com/acme/r/pull/1', run: run({ state: 'review' }) }),
  ];
}

describe('buildTranscript', () => {
  it('reduces RunLog events to transcript blocks', () => {
    const t = buildTranscript(scenario(), 'review');
    expect(t.blocks.map((b) => b.kind)).toEqual([
      'note', // claimed (queued→running state is implied and skipped)
      'assistant',
      'activity', // Write call
      'user',
      'activity', // file.change
      'turn',
      'diff',
      'activity', // Bash call (error)
      'error',
      'turn',
      'diff',
      'state', // review
      'pr',
    ]);
    expect(t.turns).toBe(2);
    expect(t.costUsd).toBeCloseTo(0.03);
    expect(t.sessionId).toBe('fake-1');
    expect(t.model).toBe('fake-model');
    expect(t.lastSeq).toBe(18);
  });

  it('pairs tool results with their calls and summarises input', () => {
    const t = buildTranscript(scenario(), 'review');
    const tools = t.blocks.flatMap((b) => (b.kind === 'activity' ? b.items : []));
    const write = tools.find((i) => i.kind === 'tool' && i.name === 'Write');
    const bash = tools.find((i) => i.kind === 'tool' && i.name === 'Bash');
    expect(write).toMatchObject({ status: 'done', output: 'ok', summary: 'hello.md' });
    expect(bash).toMatchObject({ status: 'error', output: 'boom', summary: 'ls -la' });
  });

  it('marks follow-ups delivered once the agent acts after them', () => {
    const events = scenario();
    const upToMessage = events.slice(0, 7);
    const pending = buildTranscript(upToMessage, 'running').blocks.find((b) => b.kind === 'user');
    expect(pending).toMatchObject({ pending: true, authorId: 'dev', text: 'also add bye.md' });
    const later = buildTranscript(events, 'review').blocks.find((b) => b.kind === 'user');
    expect(later).toMatchObject({ pending: false });
  });

  it('parses diff snapshots and flags only the latest', () => {
    const diffs = buildTranscript(scenario(), 'review').blocks.filter((b) => b.kind === 'diff');
    expect(diffs).toHaveLength(2);
    const [first, second] = diffs as Extract<(typeof diffs)[number], { kind: 'diff' }>[];
    expect(first).toMatchObject({ turn: 1, latest: false, truncated: false });
    expect(first!.files[0]).toMatchObject({ path: 'hello.md', status: 'added', additions: 2 });
    expect(second).toMatchObject({ turn: 2, latest: true, truncated: true, files: [] });
  });

  it('keeps a running tool running while the run is live, and settles it after', () => {
    seq = 0;
    const events = [
      agent({ type: 'tool.call', id: 'x', name: 'Bash', input: { command: 'sleep' } }),
    ];
    const tool = (state: Run['state']) =>
      buildTranscript(events, state).blocks.flatMap((b) =>
        b.kind === 'activity' ? b.items : [],
      )[0];
    expect(tool('running')).toMatchObject({ status: 'running' });
    expect(tool('failed')).toMatchObject({ status: 'done' });
  });

  it('dedupes by seq, sorts, and renders unknown / legacy events raw', () => {
    seq = 0;
    const a = agent({ type: 'message', role: 'assistant', text: 'hi' });
    const legacy = ev('run.started', { id: 'run_old' }); // Phase 0 payload: not a full Run
    const t = buildTranscript([legacy, a, a]);
    expect(t.blocks.map((b) => b.kind)).toEqual(['assistant', 'raw']);
  });
});

describe('mergeEvents', () => {
  it('dedupes by seq and keeps order', () => {
    seq = 0;
    const [a, b, c] = [ev('x', 1), ev('x', 2), ev('x', 3)];
    const prev = [a!, c!];
    expect(mergeEvents(prev, [c!])).toBe(prev);
    expect(mergeEvents(prev, [b!, b!]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('run helpers', () => {
  it('toolSummary picks the telling field and truncates', () => {
    expect(toolSummary({ command: 'git  status\n -s' })).toBe('git status -s');
    expect(toolSummary({ command: ['bash', '-lc', 'ls'] })).toBe('bash -lc ls');
    expect(toolSummary({ a: 1 })).toBe('{"a":1}');
    expect(toolSummary('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(toolSummary(undefined)).toBe('');
  });

  it('follow-up box and cancel availability follow the lifecycle', () => {
    expect(messageBlockedReason(run({ state: 'running' }))).toBeNull();
    expect(messageBlockedReason(run({ state: 'review' }))).toBeNull();
    expect(messageBlockedReason(run({ state: 'abandoned' }))).toMatch(/abandoned/);
    expect(messageBlockedReason(run({ state: 'merged' }))).toMatch(/merged/);
    expect(canCancel(run({ state: 'queued' }))).toBe(true);
    expect(canCancel(run({ state: 'running' }))).toBe(true);
    expect(canCancel(run({ state: 'review' }))).toBe(false);
    expect(canCancel(run({ state: 'abandoned' }))).toBe(false);
  });

  it('needsYouReason explains each state', () => {
    expect(needsYouReason(run({ state: 'queued' }))).toMatch(/sf daemon/);
    expect(needsYouReason(run({ state: 'review', prUrl: 'https://x.dev/p/1' }))).toMatch(/PR/);
    expect(needsYouReason(run({ state: 'failed' }))).toMatch(/Failed/);
    expect(needsYouReason(run({ state: 'blocked' }))).toMatch(/blocked/);
  });
});
