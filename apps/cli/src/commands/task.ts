import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { apiClient } from '../client';
import { fmt } from '../format';
import { inputs } from '../inputs';
import { action } from '../output';

const create = defineCommand({
  meta: { name: 'create', description: 'Create a task in a project' },
  args: {
    ...globalArgs,
    project: { type: 'string', required: true, description: 'Project id' },
    title: { type: 'string', required: true, description: 'Task title' },
  },
  run: ({ args }) =>
    action(args, () => apiClient(args).call('task.create', inputs.taskCreate(args)), fmt.task),
});

const list = defineCommand({
  meta: { name: 'list', description: "List a project's tasks" },
  args: {
    ...globalArgs,
    project: { type: 'string', description: 'Project id' },
  },
  run: ({ args }) =>
    action(
      args,
      () => apiClient(args).call('task.list', inputs.taskList(args)),
      (d) => fmt.tasks(d.tasks),
    ),
});

export default defineCommand({
  meta: { name: 'task', description: 'Tasks' },
  subCommands: { create, list },
});
