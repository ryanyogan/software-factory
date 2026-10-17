import type { Run } from '@sf/contract';
import type { RunRow } from '@sf/db';
import type { Ctx } from './context';

export const now = (ctx: Ctx) => (ctx.now ? ctx.now() : new Date());
export const newId = (ctx: Ctx, prefix: string) =>
  ctx.newId ? ctx.newId(prefix) : `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const toRun = (r: RunRow): Run => ({
  id: r.id,
  taskId: r.taskId,
  agent: r.agent,
  location: r.location,
  state: r.state,
  prompt: r.prompt,
  openPr: r.openPr,
  startedBy: r.startedBy,
  createdAt: r.createdAt.toISOString(),
  claimedBy: r.claimedBy,
  claimedAt: iso(r.claimedAt),
  sessionId: r.sessionId,
  prUrl: r.prUrl,
  costUsd: r.costUsd,
  endedAt: iso(r.endedAt),
});
