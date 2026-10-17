import type { ProjectNotice, StoredRunEvent } from '@sf/contract';
import type { EventsPort, RunEventInput } from './context';

/** In-memory EventsPort with the same semantics as the RunLog DO (seq per run, key dedupe). */
export interface MemoryEvents extends EventsPort {
  readonly runs: Map<string, StoredRunEvent[]>;
  readonly notices: { projectId: string; notice: ProjectNotice }[];
}

export function createMemoryEvents(now: () => number = Date.now): MemoryEvents {
  const runs = new Map<string, StoredRunEvent[]>();
  const keys = new Map<string, number>();
  const notices: MemoryEvents['notices'] = [];
  return {
    runs,
    notices,
    async append(runId, events: RunEventInput[]) {
      const log = runs.get(runId) ?? [];
      runs.set(runId, log);
      return events.map((e) => {
        const k = e.key === undefined ? undefined : `${runId}\0${e.key}`;
        const existing = k === undefined ? undefined : keys.get(k);
        if (existing !== undefined) return log[existing - 1]!;
        const stored: StoredRunEvent = {
          seq: log.length + 1,
          type: e.type,
          payload: e.payload ?? null,
          at: now(),
          ...(e.emittedAt === undefined ? {} : { emittedAt: e.emittedAt }),
        };
        log.push(stored);
        if (k !== undefined) keys.set(k, stored.seq);
        return stored;
      });
    },
    async list(runId, since, limit) {
      return (runs.get(runId) ?? []).filter((e) => e.seq > since).slice(0, limit);
    },
    async notifyProject(projectId, notice) {
      notices.push({ projectId, notice });
    },
  };
}
