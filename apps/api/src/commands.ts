import { CommandError, type ErrorBody } from '@sf/contract';
import { type Ctx, dispatch, type EventsPort } from '@sf/core';
import { createD1Db } from '@sf/db';
import { type AuthInput, resolveUserId } from './session';

export type CommandResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; error: ErrorBody['error'] };

/** Core's EventsPort backed by the RunLog (per run) and ProjectRoom (per project) DOs. */
export function eventsPort(env: Env): EventsPort {
  return {
    append: (runId, events) => env.RUN_LOG.getByName(runId).appendMany(events),
    list: (runId, since, limit) => env.RUN_LOG.getByName(runId).list(since, limit),
    async notifyProject(projectId, notice) {
      await env.PROJECT_ROOM.getByName(projectId).broadcast(notice);
    },
  };
}

export function ctxFor(env: Env, userId: string): Ctx {
  return { db: createD1Db(env.DB), userId, events: eventsPort(env) };
}

export function fail(err: CommandError): CommandResult {
  return { ok: false, status: err.status, error: err.toBody().error };
}

/**
 * THE command path. Both the HTTP route (CLI) and the ApiRpc entrypoint (web) call this,
 * so every surface gets identical auth → dispatch → error mapping.
 */
export async function runCommand(
  env: Env,
  name: string,
  input: unknown,
  auth: AuthInput,
): Promise<CommandResult> {
  try {
    const userId = await resolveUserId(env, auth);
    if (!userId) return fail(new CommandError('unauthorized', 'sign in required'));
    return { ok: true, data: await dispatch(ctxFor(env, userId), name, input) };
  } catch (err) {
    if (err instanceof CommandError) return fail(err);
    console.error({ msg: 'command failed', command: name, err: String(err) });
    return fail(new CommandError('internal', 'internal error'));
  }
}
