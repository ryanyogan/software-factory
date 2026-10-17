import { WorkerEntrypoint } from 'cloudflare:workers';
import { type CommandResult, runCommand } from './commands';

/** What the web app forwards from its own incoming request. */
export interface RpcAuth {
  /** Incoming request headers as entries (cookie / authorization are what matter). */
  headers?: [string, string][];
  /** A Better Auth session token; sent as `Authorization: Bearer <token>`. */
  sessionToken?: string;
  /** `new URL(request.url).origin` of the web request (dev bypass is loopback-only). */
  origin?: string;
}

/**
 * Named entrypoint for service bindings (`"entrypoint": "ApiRpc"`). Runs the exact same
 * `runCommand` as `POST /v1/commands/:name`. Returns a result union instead of throwing, because
 * custom error classes don't survive RPC serialisation.
 */
export class ApiRpc extends WorkerEntrypoint<Env> {
  async command(name: string, input: unknown, auth: RpcAuth = {}): Promise<CommandResult> {
    const headers = new Headers(auth.headers);
    if (auth.sessionToken) headers.set('authorization', `Bearer ${auth.sessionToken}`);
    return runCommand(this.env, name, input, { headers, origin: auth.origin });
  }
}
