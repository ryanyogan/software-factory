import type { Agent } from '@sf/contract';

const AGENTS: Agent[] = ['claude-code', 'codex', 'opencode'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Agents for the Start-run dialog: `fake` (scripted test agent) only when served from loopback (dev). */
export function agentsFor(hostname: string | undefined): Agent[] {
  return hostname !== undefined && LOOPBACK.has(hostname) ? [...AGENTS, 'fake'] : AGENTS;
}
