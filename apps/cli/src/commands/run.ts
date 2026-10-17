import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { apiClient } from '../client';
import { readConfig } from '../config';
import { resolveRunTarget } from '../context';
import { fmt } from '../format';
import { inputs } from '../inputs';
import { action } from '../output';

const start = defineCommand({
  meta: {
    name: 'start',
    description:
      'Start an agent run. Without --task, inside a linked repo: --title creates a task, else the task of the current branch',
  },
  args: {
    ...globalArgs,
    task: { type: 'string', description: 'Task id (default: from the linked repo, see above)' },
    title: { type: 'string', description: 'Create a task with this title in the linked project' },
    agent: {
      type: 'enum',
      options: ['claude-code', 'codex', 'opencode', 'fake'],
      required: true,
      description: 'Agent (fake = scripted, for dev/tests)',
    },
    location: {
      type: 'enum',
      options: ['local', 'cloud'],
      default: 'local',
      description: 'Where the run executes',
    },
    prompt: { type: 'string', required: true, description: 'Instruction for the agent' },
    pr: {
      type: 'boolean',
      default: true,
      description: 'Open a draft PR when the run ends (--no-pr to skip)',
    },
  },
  run: ({ args }) =>
    action(
      args,
      async () => {
        const client = apiClient(args);
        const target = await resolveRunTarget({
          cwd: process.cwd(),
          config: await readConfig(),
          client,
          task: args.task || undefined,
          title: args.title || undefined,
        });
        return client.call('run.start', inputs.runStart({ ...args, task: target.taskId }));
      },
      fmt.run,
    ),
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

const message = defineCommand({
  meta: { name: 'message', description: "Send a follow-up message to a run's agent" },
  args: {
    ...globalArgs,
    id: { type: 'positional', required: true, description: 'Run id' },
    text: { type: 'positional', required: true, description: 'Message text' },
  },
  run: ({ args }) =>
    action(
      args,
      () => apiClient(args).call('run.message', inputs.runMessage(args)),
      (d) => `Sent (seq ${d.event.seq}).`,
    ),
});

const cancel = defineCommand({
  meta: { name: 'cancel', description: 'Cancel a run (a running agent is stopped by its daemon)' },
  args: { ...globalArgs, id: { type: 'positional', required: true, description: 'Run id' } },
  run: ({ args }) =>
    action(
      args,
      () => apiClient(args).call('run.cancel', { id: args.id }),
      (r) =>
        r.state === 'running'
          ? `Cancel requested; the daemon will stop the agent.\n${fmt.run(r)}`
          : fmt.run(r),
    ),
});

export default defineCommand({
  meta: { name: 'run', description: 'Agent runs' },
  subCommands: { start, list, get, message, cancel },
});
