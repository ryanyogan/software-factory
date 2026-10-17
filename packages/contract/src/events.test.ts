import { describe, expect, it } from 'vite-plus/test';
import {
  AgentEvent,
  CommandError,
  DaemonEventBatch,
  ProjectNotice,
  parseRunEvent,
  RunState,
  runTransitions,
  TERMINAL_RUN_STATES,
} from './index';

const run = {
  id: 'run_1',
  taskId: 'tsk_1',
  agent: 'codex',
  location: 'local',
  state: 'queued',
  prompt: 'x',
  openPr: true,
  createdAt: '2026-10-17T00:00:00.000Z',
  startedBy: 'u',
  claimedBy: null,
  claimedAt: null,
  sessionId: null,
  prUrl: null,
  costUsd: null,
  endedAt: null,
};

describe('events', () => {
  it('applies AgentEvent defaults', () => {
    expect(AgentEvent.parse({ type: 'turn.completed' })).toEqual({
      type: 'turn.completed',
      isError: false,
    });
    expect(AgentEvent.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('parses typed run events and returns null for legacy/unknown ones', () => {
    expect(parseRunEvent({ seq: 1, at: 1, type: 'run.started', payload: run })?.type).toBe(
      'run.started',
    );
    expect(parseRunEvent({ seq: 1, at: 1, type: 'a', payload: 1 })).toBeNull();
    // Phase 0 run.started payloads lack the stage-8 fields
    expect(parseRunEvent({ seq: 1, at: 1, type: 'run.started', payload: { id: 'r' } })).toBeNull();
  });

  it('only lets daemons send agent and diff events', () => {
    expect(
      DaemonEventBatch.safeParse([{ type: 'agent', payload: { type: 'reasoning', text: 'hm' } }])
        .success,
    ).toBe(true);
    expect(
      DaemonEventBatch.safeParse([{ type: 'run.state', payload: { from: 'queued' } }]).success,
    ).toBe(false);
    expect(DaemonEventBatch.safeParse([]).success).toBe(false);
  });

  it('validates project notices', () => {
    expect(ProjectNotice.safeParse({ type: 'run.queued', run }).success).toBe(true);
  });
});

describe('lifecycle', () => {
  it('has an entry for every state and none out of terminal states', () => {
    expect(Object.keys(runTransitions).sort()).toEqual([...RunState.options].sort());
    for (const s of TERMINAL_RUN_STATES) expect(runTransitions[s]).toEqual({});
  });

  it('maps conflict/forbidden to 409/403', () => {
    expect(new CommandError('conflict', 'x').status).toBe(409);
    expect(new CommandError('forbidden', 'x').status).toBe(403);
  });
});
