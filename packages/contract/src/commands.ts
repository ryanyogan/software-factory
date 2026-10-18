import { z } from 'zod';
import { defineCommand } from './define';
import { DaemonEventBatch, StoredRunEvent, UserMessage } from './events';
import {
  Agent,
  HttpUrl,
  Id,
  MachineId,
  Project,
  Prompt,
  Run,
  RunLocation,
  RunState,
  Task,
} from './schemas';

export const projectCreate = defineCommand({
  name: 'project.create',
  summary: 'Create a project, optionally linked to a git repository.',
  input: z.object({ name: Project.shape.name, repoUrl: HttpUrl.optional() }),
  output: Project,
  http: { method: 'POST', path: '/v1/projects' },
});

export const projectList = defineCommand({
  name: 'project.list',
  summary: 'List projects, newest first.',
  input: z.object({}),
  output: z.object({ projects: z.array(Project) }),
  http: { method: 'GET', path: '/v1/projects' },
});

export const taskCreate = defineCommand({
  name: 'task.create',
  summary: 'Create a task in a project. Branch defaults to a slug of the title.',
  input: z.object({
    projectId: Id,
    title: Task.shape.title,
    branch: Task.shape.branch.optional(),
  }),
  output: Task,
  http: { method: 'POST', path: '/v1/tasks' },
});

export const taskList = defineCommand({
  name: 'task.list',
  summary: 'List tasks, optionally filtered by project.',
  input: z.object({ projectId: Id.optional() }),
  output: z.object({ tasks: z.array(Task) }),
  http: { method: 'GET', path: '/v1/tasks' },
});

export const runStart = defineCommand({
  name: 'run.start',
  summary: 'Queue an agent run for a task.',
  input: z.object({
    taskId: Id,
    agent: Agent,
    location: RunLocation.default('local'),
    /** Required for new runs (legacy rows carry `''`). */
    prompt: Prompt.trim().min(1),
    openPr: z.boolean().default(true),
  }),
  output: Run,
  http: { method: 'POST', path: '/v1/runs' },
});

export const runGet = defineCommand({
  name: 'run.get',
  summary: 'Fetch a single run by id.',
  input: z.object({ id: Id }),
  output: Run,
  http: { method: 'GET', path: '/v1/runs/:id' },
});

export const runList = defineCommand({
  name: 'run.list',
  summary: 'List runs, optionally filtered by task.',
  input: z.object({ taskId: Id.optional() }),
  output: z.object({ runs: z.array(Run) }),
  http: { method: 'GET', path: '/v1/runs' },
});

export const runClaim = defineCommand({
  name: 'run.claim',
  summary:
    'Atomically claim a queued local run for a daemon (queued → running). Owner only; 409 if already taken.',
  input: z.object({ id: Id, machineId: MachineId }),
  output: Run,
  http: { method: 'POST', path: '/v1/runs/:id/claim' },
});

export const runUpdate = defineCommand({
  name: 'run.update',
  summary:
    'Transition a run (see runTransitions) and/or record sessionId, costUsd, prUrl, endedAt. Owner only; daemon fields need the claimer machineId.',
  input: z.object({
    id: Id,
    /** The calling daemon. Required for `claimer` transitions and for sessionId/costUsd/prUrl. */
    machineId: MachineId.optional(),
    state: RunState.optional(),
    sessionId: Run.shape.sessionId.unwrap().optional(),
    costUsd: Run.shape.costUsd.unwrap().optional(),
    prUrl: HttpUrl.optional(),
    /** Defaults to now when entering review/failed/abandoned/merged. */
    endedAt: Run.shape.endedAt.unwrap().optional(),
  }),
  output: Run,
  http: { method: 'PATCH', path: '/v1/runs/:id' },
});

export const runMessage = defineCommand({
  name: 'run.message',
  summary: 'Send a follow-up (steer) message to the agent of a run. Owner only, any surface.',
  input: z.object({ id: Id, text: UserMessage.shape.text }),
  output: z.object({ event: StoredRunEvent }),
  http: { method: 'POST', path: '/v1/runs/:id/messages' },
});

export const runCancel = defineCommand({
  name: 'run.cancel',
  summary:
    'Cancel a run. Unclaimed/idle runs (queued, review, failed, blocked) become abandoned now; running runs get run.cancel_requested and the daemon finalizes.',
  input: z.object({ id: Id }),
  output: Run,
  http: { method: 'POST', path: '/v1/runs/:id/cancel' },
});

export const runEvents = defineCommand({
  name: 'run.events',
  summary: 'List a run’s events with seq > since (read without a WebSocket).',
  input: z.object({
    id: Id,
    since: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(1000).default(500),
  }),
  output: z.object({ events: z.array(StoredRunEvent) }),
  http: { method: 'GET', path: '/v1/runs/:id/events' },
});

export const runAppend = defineCommand({
  name: 'run.append',
  summary:
    'HTTP fallback for the daemon WebSocket: append agent/diff events. Only the claimer machine of the owner.',
  input: z.object({ id: Id, machineId: MachineId, events: DaemonEventBatch }),
  output: z.object({ seqs: z.array(z.number().int()) }),
  http: { method: 'POST', path: '/v1/runs/:id/events' },
});

export const commands = {
  'project.create': projectCreate,
  'project.list': projectList,
  'task.create': taskCreate,
  'task.list': taskList,
  'run.start': runStart,
  'run.get': runGet,
  'run.list': runList,
  'run.claim': runClaim,
  'run.update': runUpdate,
  'run.message': runMessage,
  'run.cancel': runCancel,
  'run.events': runEvents,
  'run.append': runAppend,
} as const;

export type Commands = typeof commands;
export type CommandName = keyof Commands;
/** Input as the caller writes it (defaults optional). */
export type CommandInput<N extends CommandName> = z.input<Commands[N]['input']>;
/** Input after validation (defaults applied) — what handlers receive. */
export type ParsedInput<N extends CommandName> = z.output<Commands[N]['input']>;
export type CommandOutput<N extends CommandName> = z.output<Commands[N]['output']>;

export const commandNames = Object.keys(commands) as CommandName[];

export function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(commands, name);
}
