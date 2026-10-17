/** Provider API keys removed from agent envs unless the caller opts in (subscription logins are used). */
export const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY'] as const;

export interface BuildEnvOptions {
  /** Base env, default `process.env`. */
  base?: Record<string, string | undefined>;
  extra?: Record<string, string>;
  allowApiKeys?: boolean;
  /** More variable names to drop. */
  strip?: readonly string[];
}

/**
 * The complete env for an agent child process. Both SDKs REPLACE the child env with the `env`
 * option, so this always starts from the full base env (never `{ FOO: 'x' }` alone).
 */
export function buildAgentEnv(options: BuildEnvOptions = {}): Record<string, string> {
  const drop = new Set<string>(options.strip ?? []);
  if (!options.allowApiKeys) for (const k of API_KEY_VARS) drop.add(k);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.base ?? process.env)) {
    if (v !== undefined && !drop.has(k)) env[k] = v;
  }
  return { ...env, ...options.extra };
}
