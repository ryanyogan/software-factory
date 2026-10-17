import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { apiClient } from '../client';
import { fmt } from '../format';
import { inputs } from '../inputs';
import { action } from '../output';

const start = defineCommand({
  meta: { name: 'start', description: 'Start an agent run for a task' },
  args: {
    ...globalArgs,
    task: { type: 'string', required: true, description: 'Task id' },
    agent: {
      type: 'enum',
      options: ['claude-code', 'codex', 'opencode'],
      required: true,
      description: 'Agent',
    },
    location: {
      type: 'enum',
      options: ['local', 'cloud'],
      default: 'local',
      description: 'Where the run executes',
    },
  },
  run: ({ args }) =>
    action(args, () => apiClient(args).call('run.start', inputs.runStart(args)), fmt.run),
});

const list = defineCommand({
  meta: { name: 'list', description: 'List runs (optionally for one task)' },
  args: { ...globalArgs, task: { type: 'string', description: 'Task id' } },
  run: ({ args }) =>
    action(
      args,
      () => apiClient(args).call('run.list', inputs.runList(args)),
      (d) => fmt.runs(d.runs),
    ),
});

const get = defineCommand({
  meta: { name: 'get', description: 'Show one run' },
  args: { ...globalArgs, id: { type: 'positional', required: true, description: 'Run id' } },
  run: ({ args }) =>
    action(args, () => apiClient(args).call('run.get', inputs.runGet(args)), fmt.run),
});

export default defineCommand({
  meta: { name: 'run', description: 'Agent runs' },
  subCommands: { start, list, get },
});
