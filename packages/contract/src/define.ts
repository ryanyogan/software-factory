import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CommandDef<
  Name extends string = string,
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  readonly name: Name;
  readonly summary: string;
  readonly input: I;
  readonly output: O;
  /** Canonical REST route. Every command is also reachable as `POST /v1/commands/:name`. */
  readonly http: { readonly method: HttpMethod; readonly path: string };
}

export function defineCommand<Name extends string, I extends z.ZodType, O extends z.ZodType>(
  def: CommandDef<Name, I, O>,
): CommandDef<Name, I, O> {
  return def;
}
