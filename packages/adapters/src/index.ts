// @sf/adapters — one interface over every coding agent the daemon can drive.
// This entry imports NO agent SDK: each adapter (and its SDK) loads on demand via `loadAdapter`
// or the subpath exports `@sf/adapters/claude-code`, `@sf/adapters/codex`, `@sf/adapters/fake`.
import type { AdapterName, AgentAdapter, AgentSession, StartAgentOptions } from './types';

export * from './types';
export { buildAgentEnv, API_KEY_VARS, type BuildEnvOptions } from './env';
export { findOnPath, resolveBinary } from './binaries';

export function isAdapterName(name: string): name is AdapterName {
  return name === 'claude-code' || name === 'codex' || name === 'fake';
}

/** Lazily load one adapter (its SDK is imported only when a session starts). */
export async function loadAdapter(name: string): Promise<AgentAdapter> {
  switch (name) {
    case 'claude-code':
      return (await import('./claude-code/index')).claudeCodeAdapter;
    case 'codex':
      return (await import('./codex/index')).codexAdapter;
    case 'fake':
      return (await import('./fake/index')).fakeAdapter;
    default:
      throw new Error(`no adapter for agent "${name}" (supported: claude-code, codex, fake)`);
  }
}

/** `loadAdapter(agent)` + `start(options)`. Adapter-specific options pass through. */
export async function startAgent(
  options: StartAgentOptions & { agent: string } & Record<string, unknown>,
): Promise<AgentSession> {
  const { agent, ...rest } = options;
  return (await loadAdapter(agent)).start(rest);
}
