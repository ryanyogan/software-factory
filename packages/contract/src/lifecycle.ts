import type { RunState } from './schemas';

/**
 * Who may perform a state transition through `run.update` (or `run.cancel`):
 *  - `claimer`: the run owner's daemon that claimed it (`machineId === run.claimedBy`).
 *  - `owner`: the run owner from any surface (web/CLI/MCP), with or without a machine id.
 * A claimer is always acting as the owner, so it may also do `owner` transitions.
 * `queued → running` is NOT here: it only happens through `run.claim` (atomic).
 * `checks` / `final_review` are reserved for Phase 4 and have no transitions yet.
 */
export type TransitionActor = 'claimer' | 'owner';

export const runTransitions: Readonly<
  Record<RunState, Readonly<Partial<Record<RunState, TransitionActor>>>>
> = {
  queued: { abandoned: 'owner' },
  // running → abandoned is `owner` so a dead daemon can't strand a run (run.update escape hatch).
  running: { blocked: 'claimer', review: 'claimer', failed: 'claimer', abandoned: 'owner' },
  blocked: { running: 'claimer', failed: 'claimer', abandoned: 'owner' },
  // A follow-up on a run in review/failed lets the daemon resume the session.
  review: { running: 'claimer', merged: 'owner', abandoned: 'owner' },
  failed: { running: 'claimer', abandoned: 'owner' },
  checks: {},
  final_review: {},
  merged: {},
  abandoned: {},
};

/** States after which the run accepts no follow-ups, events or transitions. */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(['merged', 'abandoned']);

/** Entering one of these stamps `endedAt`; going back to `running` clears it. */
export const ENDED_RUN_STATES: ReadonlySet<RunState> = new Set([
  'review',
  'failed',
  'abandoned',
  'merged',
]);

export function transitionActor(from: RunState, to: RunState): TransitionActor | undefined {
  return runTransitions[from][to];
}
