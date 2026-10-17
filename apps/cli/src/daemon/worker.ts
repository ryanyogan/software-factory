import { join } from 'node:path';
import type { AgentResult, AgentSession, StartAgentOptions } from '@sf/adapters';
import {
  type AgentEvent,
  type CommandInput,
  DIFF_PATCH_MAX,
  type Run,
  type RunState,
  type StoredRunEvent,
  type Task,
  UserMessage,
} from '@sf/contract';
import { aheadCount, commitAll, diffAgainst, type EnsuredWorktree, ensureWorktree } from '../git';
import type { PrProvider } from '../pr';
import type { DaemonTransport, SocketTimings } from './socket';
import { RunLogWriter } from './writer';

export type StartAgentFn = (
  options: StartAgentOptions & { agent: string } & Record<string, unknown>,
) => Promise<AgentSession>;

export interface WorkerDeps {
  transport: DaemonTransport;
  machineId: string;
  dataDir: string;
  prProvider: PrProvider;
  startAgent: StartAgentFn;
  /** Base env for agents (default process.env; e.g. carries SF_FAKE_SCRIPT). */
  agentEnv?: Record<string, string | undefined>;
  log: (msg: string) => void;
  timings?: Partial<SocketTimings>;
}

export type CancelReason = 'user' | 'shutdown';

/** `$dataDir/worktrees/<projectId>/<taskId>` */
export function worktreePath(dataDir: string, projectId: string, taskId: string): string {
  return join(dataDir, 'worktrees', projectId, taskId);
}

const ENDS: ReadonlySet<string> = new Set(['review', 'failed']);

/**
 * Executes one claimed run on this machine:
 * worktree → RunLog writer socket → agent session (follow-ups, cancel) → per-turn diff snapshots →
 * commit → draft PR → final state. `mode: 'resume'` re-enters a run in review/failed because a
 * follow-up arrived after its session ended.
 */
export class RunWorker {
  private run: Run;
  private writer: RunLogWriter | undefined;
  private session: AgentSession | undefined;
  private cancelReason: CancelReason | undefined;
  private readonly handled = new Set<string>();
  private pending: UserMessage[] = [];
  private turn = 0;
  private cost = 0;
  private wt: EnsuredWorktree | undefined;
  readonly done: Promise<void>;
  private startResolve!: () => void;

  constructor(
    private readonly deps: WorkerDeps,
    run: Run,
    private readonly task: Task,
    private readonly repoRoot: string,
    private readonly mode: 'new' | 'resume',
    carry: UserMessage[] = [],
  ) {
    this.run = run;
    for (const m of carry) this.deliver(m);
    this.done = new Promise((r) => (this.startResolve = r));
  }

  get runId(): string {
    return this.run.id;
  }

  /** Follow-ups received too late for this execution (the daemon resumes the run for them). */
  takeLeftovers(): UserMessage[] {
    const left = this.pending;
    this.pending = [];
    return left;
  }

  get taskId(): string {
    return this.task.id;
  }

  private get client() {
    return this.deps.transport.client;
  }

  private log(msg: string): void {
    this.deps.log(`[${this.run.id}] ${msg}`);
  }

  /** Runs to completion; never throws. */
  start(): Promise<void> {
    void this.execute().finally(() => this.startResolve());
    return this.done;
  }

  cancel(reason: CancelReason): void {
    if (this.cancelReason) return;
    this.cancelReason = reason;
    this.log(`cancel (${reason})`);
    this.session?.cancel();
  }

  /** A follow-up from the RunLog socket or the project room (deduped by message id). */
  deliver(message: UserMessage): void {
    if (this.handled.has(message.id)) return;
    this.handled.add(message.id);
    if (this.session && !this.cancelReason) {
      try {
        this.session.send(message.text);
        this.log(`follow-up ${message.id} → agent`);
        return;
      } catch {
        // session already ending: resume after it
      }
    }
    this.pending.push(message);
  }

  private update(patch: Omit<CommandInput<'run.update'>, 'id' | 'machineId'>) {
    return this.client
      .call('run.update', { id: this.run.id, machineId: this.deps.machineId, ...patch })
      .then((r) => (this.run = r));
  }

  private emitAgent(ev: AgentEvent): void {
    this.writer?.append({ type: 'agent', payload: ev, emittedAt: Date.now() });
  }

  private async history(): Promise<StoredRunEvent[]> {
    const all: StoredRunEvent[] = [];
    for (;;) {
      const since = all.at(-1)?.seq ?? 0;
      const { events } = await this.client.call('run.events', {
        id: this.run.id,
        since,
        limit: 1000,
      });
      all.push(...events);
      if (events.length < 1000) return all;
    }
  }

  private onLogEvent = (e: StoredRunEvent): void => {
    if (e.type === 'user.message') {
      const m = UserMessage.safeParse(e.payload);
      if (m.success) this.deliver(m.data);
    } else if (e.type === 'run.cancel_requested') {
      this.cancel('user');
    } else if (e.type === 'run.state') {
      const to = (e.payload as { to?: string } | null)?.to;
      if (to === 'abandoned') this.cancel('user');
    }
  };

  private async execute(): Promise<void> {
    try {
      if (this.mode === 'resume') await this.update({ state: 'running' });
      const path = worktreePath(this.deps.dataDir, this.task.projectId, this.task.id);
      this.wt = await ensureWorktree({ repo: this.repoRoot, path, branch: this.task.branch });
      this.log(`worktree ${this.wt.path} (${this.wt.branch}, base ${this.wt.baseBranch})`);

      // Catch up: which follow-ups are not handled yet, and the turn count so far.
      const events = await this.history();
      let lastEnd = 0;
      for (const e of events) {
        const to = (e.payload as { to?: string } | null)?.to;
        if (e.type === 'run.state' && to && ENDS.has(to)) lastEnd = e.seq;
        if (e.type === 'diff.snapshot') this.turn++;
      }
      for (const e of events) {
        if (e.type !== 'user.message') continue;
        const m = UserMessage.safeParse(e.payload);
        if (!m.success) continue;
        if (e.seq < lastEnd) this.handled.add(m.data.id);
        else this.deliver(m.data);
      }

      this.writer = new RunLogWriter({
        runId: this.run.id,
        machineId: this.deps.machineId,
        transport: this.deps.transport,
        since: events.at(-1)?.seq ?? 0,
        onEvent: this.onLogEvent,
        log: this.deps.log,
        timings: this.deps.timings,
      });
      this.writer.start();

      this.cost = this.run.costUsd ?? 0;
      let resumeId = this.run.sessionId ?? undefined;
      let prompt: string;
      if (this.mode === 'new') {
        prompt = this.run.prompt;
        if (!resumeId) resumeId = await this.priorSession();
      } else {
        prompt = this.takePending() ?? 'Continue.';
      }

      let result: AgentResult;
      for (;;) {
        result = await this.runSession(prompt, resumeId);
        if (this.cancelReason || (!result.ok && result.turns === 0)) break;
        const next = this.takePending();
        if (!next) break;
        // Follow-ups that arrived as the session was ending: resume the same agent session.
        prompt = next;
        resumeId = result.sessionId ?? resumeId;
      }
      await this.finish(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`failed: ${message}`);
      this.emitAgent({ type: 'error', message, fatal: true });
      await this.setFinal(this.cancelReason === 'user' ? 'abandoned' : 'failed');
    } finally {
      await this.writer?.close();
      this.log(`done (${this.run.state})`);
    }
  }

  private takePending(): string | undefined {
    if (!this.pending.length) return undefined;
    const text = this.pending.map((m) => m.text).join('\n\n');
    this.pending = [];
    return text;
  }

  /** A new run on a task resumes the latest earlier session of the same agent, if any. */
  private async priorSession(): Promise<string | undefined> {
    const { runs } = await this.client.call('run.list', { taskId: this.task.id });
    const prior = runs
      .filter((r) => r.id !== this.run.id && r.agent === this.run.agent && r.sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return prior?.sessionId ?? undefined;
  }

  /** Claude's `total_cost_usd` continues across resume: the session's earlier total (all runs). */
  private async costBase(sessionId: string): Promise<number> {
    const { runs } = await this.client.call('run.list', { taskId: this.task.id });
    return runs
      .filter((r) => r.sessionId === sessionId)
      .reduce((sum, r) => sum + (r.id === this.run.id ? this.cost : (r.costUsd ?? 0)), 0);
  }

  private async runSession(prompt: string, resumeSessionId?: string): Promise<AgentResult> {
    const empty: AgentResult = {
      ok: false,
      cancelled: true,
      sessionId: resumeSessionId ?? null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      turns: 0,
    };
    if (this.cancelReason) return empty;
    const wt = this.wt!;
    const costBaseUsd = resumeSessionId ? await this.costBase(resumeSessionId) : undefined;
    this.log(`agent ${this.run.agent}${resumeSessionId ? ` (resume ${resumeSessionId})` : ''}`);
    const session = await this.deps.startAgent({
      agent: this.run.agent,
      cwd: wt.path,
      prompt,
      env: this.deps.agentEnv ?? process.env,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(costBaseUsd !== undefined ? { costBaseUsd } : {}),
      onStderr: (chunk: string) => {
        const line = chunk.trim();
        if (line) this.log(`stderr: ${line.slice(0, 500)}`);
      },
    });
    this.session = session;
    if (this.cancelReason) session.cancel();
    // Follow-ups queued before the session existed (e.g. sent while the run was queued).
    const early = this.takePending();
    if (early) session.send(early);

    for await (const ev of session.events) {
      this.emitAgent(ev);
      if (ev.type === 'session.started' && ev.sessionId !== this.run.sessionId) {
        await this.update({ sessionId: ev.sessionId }).catch((e: unknown) =>
          this.log(`sessionId update failed: ${String(e)}`),
        );
      } else if (ev.type === 'turn.completed') {
        await this.snapshot();
        if (ev.usage?.costUsd !== undefined) {
          this.cost += ev.usage.costUsd;
          await this.update({ costUsd: round(this.cost) }).catch((e: unknown) =>
            this.log(`cost update failed: ${String(e)}`),
          );
        }
        if (session.idle && !this.pending.length) session.end();
      }
    }
    const result = await session.result;
    this.session = undefined;
    return result;
  }

  private async snapshot(): Promise<void> {
    const wt = this.wt!;
    try {
      const diff = await diffAgainst(wt.path, wt.baseSha, DIFF_PATCH_MAX);
      this.writer?.append({
        type: 'diff.snapshot',
        payload: {
          turn: ++this.turn,
          base: wt.baseSha,
          patch: diff.patch,
          stats: diff.stats,
          ...(diff.truncated ? { truncated: true } : {}),
        },
        emittedAt: Date.now(),
      });
    } catch (e) {
      this.log(`diff failed: ${String(e)}`);
    }
  }

  private async finish(result: AgentResult): Promise<void> {
    const wt = this.wt!;
    if (this.cancelReason === 'user') {
      await this.setFinal('abandoned');
      return;
    }
    const sha = await commitAll(wt.path, `${this.task.title}\n\nsf run ${this.run.id}\n`);
    if (sha) this.log(`committed ${sha.slice(0, 10)} on ${wt.branch}`);
    if (this.cancelReason === 'shutdown') {
      this.emitAgent({ type: 'error', message: 'sf daemon stopped during the run', fatal: true });
      await this.setFinal('failed');
      return;
    }
    if (!result.ok) {
      await this.setFinal('failed');
      return;
    }
    let prUrl: string | undefined;
    if (this.run.openPr && (await aheadCount(wt.path, wt.baseSha)) > 0) {
      try {
        const pr = await this.deps.prProvider.open({
          cwd: wt.path,
          branch: wt.branch,
          base: wt.baseBranch,
          title: this.task.title,
          body: `${this.run.prompt}\n\n---\nOpened by sf (${this.run.agent}, run ${this.run.id}).\n`,
        });
        if (pr) {
          prUrl = pr.url;
          this.log(`PR ${pr.url} (${this.deps.prProvider.name})`);
        }
      } catch (e) {
        const message = `opening the PR failed: ${e instanceof Error ? e.message : String(e)}`;
        this.log(message);
        this.emitAgent({ type: 'error', message, fatal: false });
      }
    }
    // A cancel that raced the wrap-up still wins.
    const state =
      (this.cancelReason as CancelReason | undefined) === 'user' ? 'abandoned' : 'review';
    await this.setFinal(state, prUrl !== undefined && prUrl !== this.run.prUrl ? prUrl : undefined);
  }

  private async setFinal(state: RunState, prUrl?: string): Promise<void> {
    try {
      await this.writer?.flush();
      await this.update({
        state,
        ...(prUrl ? { prUrl } : {}),
        ...(this.cost ? { costUsd: round(this.cost) } : {}),
      });
    } catch (e) {
      // e.g. the owner already abandoned it (terminal → 409): nothing left to do.
      this.log(`final update to ${state} failed: ${String(e)}`);
      await this.client
        .call('run.get', { id: this.run.id })
        .then((r) => (this.run = r))
        .catch(() => undefined);
    }
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
