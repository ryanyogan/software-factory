import type { CommandInput, CommandName, CommandOutput } from '@sf/contract';
import { createServerFn } from '@tanstack/react-start';
import { getViewer, rpcCommand } from './api.server';
import { unwrap } from './result';

/** One server function for every command: web → `env.API.command` (RPC) → api `runCommand`. */
export const commandFn = createServerFn({ method: 'POST' })
  .validator((d: { name: CommandName; input: unknown }) => d)
  .handler(({ data }) => rpcCommand(data.name, data.input));

export const viewerFn = createServerFn({ method: 'GET' }).handler(() => getViewer());

export async function callCommand<N extends CommandName>(
  name: N,
  input: CommandInput<N>,
): Promise<CommandOutput<N>> {
  return unwrap(name, await commandFn({ data: { name, input } }));
}
