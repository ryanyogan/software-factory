import {
  type CommandName,
  type CommandOutput,
  CommandError,
  type ErrorCode,
  commands,
} from '@sf/contract';
import type { RpcResult } from './api.server';

/** Turn the RPC result union into typed output or a thrown `CommandError` (validated by the contract). */
export function unwrap<N extends CommandName>(name: N, result: RpcResult): CommandOutput<N> {
  if (!result.ok) {
    throw new CommandError(
      result.error.code as ErrorCode,
      result.error.message,
      result.error.issues,
    );
  }
  return commands[name].output.parse(result.data) as CommandOutput<N>;
}
