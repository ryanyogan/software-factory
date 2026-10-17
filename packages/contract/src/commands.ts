import { z } from 'zod';
import { defineCommand } from './define';
import { Agent, Id, Project, Run, RunLocation, Task } from './schemas';

export const projectCreate = defineCommand({
  name: 'project.create',
  summary: 'Create a project, optionally linked to a git repository.',
  input: z.object({ name: Project.shape.name, repoUrl: z.url().optional() }),
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

export const commands = {
  'project.create': projectCreate,
  'project.list': projectList,
  'task.create': taskCreate,
  'task.list': taskList,
  'run.start': runStart,
  'run.get': runGet,
  'run.list': runList,
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
