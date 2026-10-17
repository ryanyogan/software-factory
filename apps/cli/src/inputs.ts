import type { CommandInput } from '@sf/contract';

/** Pure arg → command-input mapping (one place, unit-tested). Empty strings count as absent. */
const opt = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);

export const inputs = {
  projectCreate: (a: { name: string; repo?: string }): CommandInput<'project.create'> => ({
    name: a.name,
    repoUrl: opt(a.repo),
  }),
  taskCreate: (a: { project: string; title: string }): CommandInput<'task.create'> => ({
    projectId: a.project,
    title: a.title,
  }),
  taskList: (a: { project?: string }): CommandInput<'task.list'> => ({
    projectId: opt(a.project),
  }),
  runStart: (a: { task: string; agent: string; location?: string }): CommandInput<'run.start'> =>
    ({
      taskId: a.task,
      agent: a.agent,
      location: opt(a.location),
    }) as CommandInput<'run.start'>,
  runList: (a: { task?: string }): CommandInput<'run.list'> => ({ taskId: opt(a.task) }),
  runGet: (a: { id: string }): CommandInput<'run.get'> => ({ id: a.id }),
};
