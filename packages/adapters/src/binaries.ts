import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { BinaryChoice } from './types';

/** First executable named `name` on `PATH`, or null. No subprocess. */
export function findOnPath(
  name: string,
  pathVar: string | undefined = process.env.PATH,
): string | null {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * Resolve a `BinaryChoice` to an absolute path, or `undefined` for "let the SDK use its bundled binary".
 * `'auto'` prefers the local CLI on PATH (no 273/411 MB optional-dependency binary needed).
 */
export function resolveBinary(
  choice: BinaryChoice | undefined,
  name: string,
  pathVar?: string,
): string | undefined {
  if (choice === 'bundled') return undefined;
  if (choice === undefined || choice === 'auto') return findOnPath(name, pathVar) ?? undefined;
  if (!isAbsolute(choice)) throw new Error(`binary path must be absolute: ${choice}`);
  return choice;
}
