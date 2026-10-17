import { type CommandInput, type CommandName, type CommandOutput, commands } from './commands';
import { CommandError, type ErrorBody } from './errors';

export interface ClientOptions {
  /** e.g. `http://localhost:3000` — commands are POSTed to `${baseUrl}/v1/commands/<name>`. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Bearer token (Better Auth session token from `sf login`). */
  token?: string | (() => string | undefined | Promise<string | undefined>);
}

export interface Client {
  call<N extends CommandName>(name: N, input: CommandInput<N>): Promise<CommandOutput<N>>;
}

/** The uniform RPC-over-HTTP path every command is reachable on. */
export function commandPath(name: CommandName): string {
  return `/v1/commands/${name}`;
}

export function createClient(opts: ClientOptions): Client {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.baseUrl.replace(/\/+$/, '');

  return {
    async call(name, input) {
      const def = commands[name];
      const token = typeof opts.token === 'function' ? await opts.token() : opts.token;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (token) headers.authorization = `Bearer ${token}`;

      const res = await doFetch(`${base}${commandPath(name)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input ?? {}),
      });
      const body: unknown = await res.json().catch(() => undefined);

      if (!res.ok) {
        const err = (body as ErrorBody | undefined)?.error;
        throw new CommandError(
          err?.code ?? (res.status === 401 ? 'unauthorized' : 'internal'),
          err?.message ?? `${name} failed with HTTP ${res.status}`,
          err?.issues,
        );
      }
      const parsed = def.output.safeParse(body);
      if (!parsed.success) {
        throw new CommandError(
          'invalid_output',
          `${name}: unexpected response`,
          parsed.error.issues,
        );
      }
      return parsed.data as CommandOutput<typeof name>;
    },
  };
}
