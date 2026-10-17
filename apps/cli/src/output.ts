import type { GlobalArgs } from './args';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const io: Io = {
  out: (text) => void process.stdout.write(`${text}\n`),
  err: (text) => void process.stderr.write(`${text}\n`),
};

export type Column<T> = [header: string, get: (row: T) => string | undefined];

/** Compact, left-aligned table: uppercase headers, two-space gutters, no borders. */
export function table<T>(rows: readonly T[], columns: Column<T>[]): string {
  if (rows.length === 0) return '(none)';
  const cells = [
    columns.map(([h]) => h.toUpperCase()),
    ...rows.map((r) => columns.map(([, get]) => get(r) ?? '')),
  ];
  const widths = columns.map((_, i) => Math.max(...cells.map((line) => line[i]!.length)));
  return cells
    .map((line) =>
      line
        .map((cell, i) => (i === line.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** Aligned `key  value` lines for a single record. */
export function record(fields: [string, string | undefined][]): string {
  const width = Math.max(...fields.map(([k]) => k.length));
  return fields.map(([k, v]) => `${k.padEnd(width)}  ${v ?? ''}`).join('\n');
}

/** `2026-10-17T11:15:54.123Z` → `2026-10-17 11:15`. */
export function shortTime(iso: string | undefined): string | undefined {
  return iso?.replace('T', ' ').slice(0, 16);
}

interface ErrorLike {
  code?: string;
  message: string;
  issues?: unknown;
}

function toErrorBody(e: unknown): { error: ErrorLike } {
  if (e && typeof e === 'object' && 'toBody' in e && typeof e.toBody === 'function')
    return e.toBody() as { error: ErrorLike };
  const message = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
  return { error: { code: 'cli_error', message: message + cause } };
}

/**
 * Runs a command body and prints its result: `--json` → JSON on stdout, else `human(data)`.
 * Errors → stderr (or JSON `{ error }` on stdout with `--json`) and exit code 1.
 */
export async function action<T>(
  args: GlobalArgs,
  fn: () => Promise<T>,
  human: (data: T) => string,
  out: Io = io,
): Promise<T | undefined> {
  try {
    const data = await fn();
    out.out(args.json ? JSON.stringify(data) : human(data));
    return data;
  } catch (e) {
    const body = toErrorBody(e);
    if (args.json) out.out(JSON.stringify(body));
    else out.err(`error: ${body.error.code ? `${body.error.code}: ` : ''}${body.error.message}`);
    process.exitCode = 1;
    return undefined;
  }
}
