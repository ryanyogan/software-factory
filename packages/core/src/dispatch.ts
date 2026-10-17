import {
  type CommandName,
  CommandError,
  type CommandOutput,
  commands,
  isCommandName,
} from '@sf/contract';
import type { Ctx } from './context';
import { type Handler, handlers } from './handlers';

/**
 * The single entry point both surfaces (web RPC and CLI HTTP) go through:
 * validate input with the contract → run handler → validate output.
 * Throws CommandError (use `.status` / `.toBody()` to build an HTTP response).
 */
export async function dispatch<N extends CommandName>(
  ctx: Ctx,
  name: N,
  rawInput: unknown,
): Promise<CommandOutput<N>>;
export async function dispatch(ctx: Ctx, name: string, rawInput: unknown): Promise<unknown>;
export async function dispatch(ctx: Ctx, name: string, rawInput: unknown): Promise<unknown> {
  if (!isCommandName(name)) throw new CommandError('unknown_command', `unknown command: ${name}`);
  const def = commands[name];

  const input = def.input.safeParse(rawInput ?? {});
  if (!input.success) {
    throw new CommandError('invalid_input', `${name}: invalid input`, input.error.issues);
  }

  const handler = handlers[name] as Handler<CommandName>;
  const result = await handler(ctx, input.data as never);

  const output = def.output.safeParse(result);
  if (!output.success) {
    throw new CommandError(
      'invalid_output',
      `${name}: handler returned invalid output`,
      output.error.issues,
    );
  }
  return output.data;
}
