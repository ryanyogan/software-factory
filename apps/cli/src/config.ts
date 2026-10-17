import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SfConfig {
  /** Better Auth session token from `sf login` (sent as `Authorization: Bearer`). */
  token?: string;
  /** API the token was issued by. */
  apiUrl?: string;
  user?: { id: string; email?: string; name?: string };
  /** Stable daemon machine id (`mch_<uuid>`), generated once by `sf daemon`. */
  machineId?: string;
  /** Repo root (main checkout, absolute) → project, written by `sf link`. */
  links?: Record<string, RepoLink>;
  daemon?: DaemonConfig;
}

export interface RepoLink {
  projectId: string;
  linkedAt: string;
}

export interface DaemonConfig {
  /** Runs executing at once (default 2). */
  maxConcurrency?: number;
  /** `gh` (default) | `fake` | `none`; env `SF_PR_PROVIDER` wins. */
  prProvider?: string;
}

export const DEFAULT_API_URL = 'http://localhost:5173';

/** `$SF_CONFIG_DIR` or `$XDG_CONFIG_HOME/sf` or `~/.config/sf`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.SF_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'sf');
  return join(dir, 'config.json');
}

export async function readConfig(path = configPath()): Promise<SfConfig> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SfConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(config: SfConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode only applies on create
}

export async function clearConfig(path = configPath()): Promise<void> {
  await rm(path, { force: true });
}

/** `$SF_DATA_DIR` or `$XDG_DATA_HOME/sf` or `~/.local/share/sf` (worktrees live here). */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SF_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'sf');
}

/** Read-modify-write the config file. */
export async function updateConfig(
  fn: (c: SfConfig) => SfConfig | void,
  path = configPath(),
): Promise<SfConfig> {
  const current = await readConfig(path);
  const next = fn(current) ?? current;
  await writeConfig(next, path);
  return next;
}

/** --api > SF_API_URL > default. */
export function resolveApiUrl(flag: string | undefined, env = process.env): string {
  return (flag || env.SF_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
}
