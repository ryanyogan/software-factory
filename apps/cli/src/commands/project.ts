import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { apiClient } from '../client';
import { fmt } from '../format';
import { inputs } from '../inputs';
import { action } from '../output';

const create = defineCommand({
  meta: { name: 'create', description: 'Create a project' },
  args: {
    ...globalArgs,
    name: { type: 'string', required: true, description: 'Project name' },
    repo: { type: 'string', description: 'Repository URL' },
  },
  run: ({ args }) =>
    action(
      args,
      () => apiClient(args).call('project.create', inputs.projectCreate(args)),
      fmt.project,
    ),
});

const list = defineCommand({
  meta: { name: 'list', description: 'List projects' },
  args: { ...globalArgs },
  run: ({ args }) =>
    action(
      args,
      () => apiClient(args).call('project.list', {}),
      (d) => fmt.projects(d.projects),
    ),
});

export default defineCommand({
  meta: { name: 'project', description: 'Projects' },
  subCommands: { create, list },
});
