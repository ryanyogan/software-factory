import { ProjectNotice, type Run, type Task, type UserMessage } from '@sf/contract';
import { ManagedSocket } from './socket';
import { RunWorker, type WorkerDeps } from './worker';

export interface DaemonOptions extends WorkerDeps {
  /** projectId → main repo root (from `sf link`). */
  projects: Map<string, string>;
  /** Runs executing at once (default 2). */
  maxConcurrency?: number;
  /** The signed-in user's id, when known: only their runs are claimed (others would 403). */
  userId?: string;
}

const isConflict = (e: unknown) => (e as { code?: string }).code === 'conflict';
const isForbidden = (e: unknown) => (e as { code?: string }).code === 'forbidden';

/**
 * `sf daemon`: one per machine. Subscribes to the ProjectRoom of every linked project, claims queued
 * local runs (`run.claim`; 409 = another machine won), and runs each in a RunWorker. At most
 * `maxConcurrency` runs at once and one run per task. Rooms do not replay, so every (re)connect and
 * every finished run triggers a catch-up scan with `run.list`.
 */
export class Daemon {
  private readonly rooms = new Map<string, ManagedSocket>();
  private readonly workers = new Map<string, RunWorker>();
  private readonly busyTasks = new Set<string>();
  private readonly tasks = new Map<string, Task>();
  private readonly skip = new Set<string>();
  /** runId → follow-ups to carry into the resumed execution (ones the last one got too late). */
  private readonly resumeWanted = new Map<string, UserMessage[]>();
  private readonly claiming = new Set<string>();
  private scanning: Promise<void> | undefined;
  private rescan = false;
  private recovered = false;
  private stopping = false;
  readonly stats = { claimed: 0, conflicts: 0, resumed: 0 };

  constructor(private readonly opts: DaemonOptions) {}

  private get client() {
    return this.opts.transport.client;
  }

  private get max(): number {
    return Math.max(1, this.opts.maxConcurrency ?? 2);
  }

  private log(msg: string): void {
    this.opts.log(msg);
  }

  /** Active run ids (for tests / status). */
  get active(): string[] {
    return [...this.workers.keys()];
  }

  async start(): Promise<void> {
    for (const [projectId, repo] of this.opts.projects) {
      const room = new ManagedSocket({
        label: `room ${projectId}`,
        log: this.opts.log,
        timings: this.opts.timings,
        open: () =>
          this.opts.transport.connect(`/v1/projects/${encodeURIComponent(projectId)}/room`),
        onOpen: () => {
          this.log(`room ${projectId} connected (${repo})`);
          void this.scan();
        },
        onClose: () => this.log(`room ${projectId} disconnected`),
        onMessage: (text) => this.onNotice(projectId, text),
      });
      this.rooms.set(projectId, room);
      room.start();
    }
    await this.scan();
  }

  /** Stop listening, cancel running agents (their runs end `failed`), wait for wrap-up. */
  async stop(timeoutMs = 15_000): Promise<void> {
    this.stopping = true;
    for (const room of this.rooms.values()) room.stop();
    const workers = [...this.workers.values()];
    for (const w of workers) w.cancel('shutdown');
    await Promise.race([
      Promise.all(workers.map((w) => w.done)),
      new Promise((r) => setTimeout(r, timeoutMs).unref()),
    ]);
    await this.scanning?.catch(() => undefined);
  }

  /** Resolves when no worker is running (tests). */
  async idle(): Promise<void> {
    while (this.workers.size || this.scanning || this.claiming.size) {
      await Promise.all([...this.workers.values()].map((w) => w.done));
      await this.scanning?.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private async refreshTasks(projectId?: string): Promise<void> {
    const ids = projectId ? [projectId] : [...this.opts.projects.keys()];
    for (const id of ids) {
      const { tasks } = await this.client.call('task.list', { projectId: id });
      for (const t of tasks) this.tasks.set(t.id, t);
    }
  }

  private async taskOf(run: Run): Promise<Task | undefined> {
    if (!this.tasks.has(run.taskId)) await this.refreshTasks();
    return this.tasks.get(run.taskId);
  }

  private mine(run: Run): boolean {
    return (
      run.location === 'local' &&
      (this.opts.userId === undefined || run.startedBy === this.opts.userId) &&
      !this.skip.has(run.id)
    );
  }

  /** Catch-up: claim queued local runs of linked projects (oldest first), within the limits. */
  scan(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.rescan = false;
          await this.refreshTasks();
          const { runs } = await this.client.call('run.list', {});
          const linked = runs.filter((r) => {
            const t = this.tasks.get(r.taskId);
            return t !== undefined && this.opts.projects.has(t.projectId);
          });
          if (!this.recovered) {
            this.recovered = true;
            await this.recoverStale(linked);
          }
          const queued = linked
            .filter((r) => r.state === 'queued' && this.mine(r))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          for (const run of queued) await this.tryClaim(run);
          for (const runId of [...this.resumeWanted.keys()]) await this.tryResume(runId);
        } while (this.rescan && !this.stopping);
      } catch (e) {
        this.log(`scan failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.scanning = undefined;
      }
    })();
    return this.scanning;
  }

  /** Runs this machine left `running` (crash/kill): no agent is behind them any more → failed. */
  private async recoverStale(runs: Run[]): Promise<void> {
    for (const r of runs) {
      if (r.state !== 'running' || r.claimedBy !== this.opts.machineId || this.workers.has(r.id))
        continue;
      this.log(`[${r.id}] was left running by an earlier daemon → failed`);
      await this.client
        .call('run.update', { id: r.id, machineId: this.opts.machineId, state: 'failed' })
        .catch((e: unknown) => this.log(`[${r.id}] recover failed: ${String(e)}`));
    }
  }

  private hasSlot(taskId: string): boolean {
    return (
      !this.stopping &&
      this.workers.size + this.claiming.size < this.max &&
      !this.busyTasks.has(taskId)
    );
  }

  private async tryClaim(run: Run): Promise<void> {
    if (this.workers.has(run.id) || this.claiming.has(run.id) || !this.mine(run)) return;
    const task = await this.taskOf(run);
    if (!task) return;
    const repo = this.opts.projects.get(task.projectId);
    if (!repo || !this.hasSlot(task.id)) return;
    this.claiming.add(run.id);
    this.busyTasks.add(task.id);
    try {
      const claimed = await this.client.call('run.claim', {
        id: run.id,
        machineId: this.opts.machineId,
      });
      this.stats.claimed++;
      this.log(`[${run.id}] claimed (${run.agent}, task ${task.id})`);
      this.spawn(new RunWorker(this.opts, claimed, task, repo, 'new'));
    } catch (e) {
      this.busyTasks.delete(task.id);
      if (isConflict(e)) {
        this.stats.conflicts++;
        this.log(`[${run.id}] already claimed elsewhere (409), skipping`);
      } else if (isForbidden(e)) {
        this.skip.add(run.id);
      } else {
        this.log(`[${run.id}] claim failed: ${String(e)}`);
      }
    } finally {
      this.claiming.delete(run.id);
    }
  }

  /** A follow-up on a run of ours that already ended (review/failed): resume its session. */
  private async tryResume(runId: string): Promise<void> {
    if (this.workers.has(runId) || this.claiming.has(runId)) return;
    let run: Run;
    try {
      run = await this.client.call('run.get', { id: runId });
    } catch {
      this.resumeWanted.delete(runId);
      return;
    }
    if (
      run.claimedBy !== this.opts.machineId ||
      (run.state !== 'review' && run.state !== 'failed')
    ) {
      this.resumeWanted.delete(runId);
      return;
    }
    const task = await this.taskOf(run);
    const repo = task && this.opts.projects.get(task.projectId);
    if (!task || !repo) {
      this.resumeWanted.delete(runId);
      return;
    }
    if (!this.hasSlot(task.id)) return; // stays wanted; retried when a slot frees
    const carry = this.resumeWanted.get(runId) ?? [];
    this.resumeWanted.delete(runId);
    this.busyTasks.add(task.id);
    this.stats.resumed++;
    this.log(`[${runId}] follow-up on a ${run.state} run → resuming`);
    this.spawn(new RunWorker(this.opts, run, task, repo, 'resume', carry));
  }

  private spawn(worker: RunWorker): void {
    this.workers.set(worker.runId, worker);
    void worker.start().then(() => {
      this.workers.delete(worker.runId);
      this.busyTasks.delete(worker.taskId);
      // A follow-up that arrived during wrap-up: resume once the run is in review/failed.
      const late = worker.takeLeftovers();
      if (late.length) this.resumeWanted.set(worker.runId, late);
      void this.scan();
    });
  }

  private onNotice(projectId: string, text: string): void {
    let parsed: ProjectNotice;
    try {
      const r = ProjectNotice.safeParse(JSON.parse(text));
      if (!r.success) return;
      parsed = r.data;
    } catch {
      return;
    }
    const n = parsed;
    switch (n.type) {
      case 'run.queued':
        if (n.run.location === 'local') {
          void this.refreshTasks(projectId)
            .then(() => this.tryClaim(n.run))
            .catch((e: unknown) => this.log(`claim on notice failed: ${String(e)}`));
        }
        break;
      case 'run.state':
        if (n.to === 'abandoned') this.workers.get(n.run.id)?.cancel('user');
        break;
      case 'run.cancel_requested':
        this.workers.get(n.runId)?.cancel('user');
        break;
      case 'run.message': {
        const w = this.workers.get(n.runId);
        if (w) w.deliver(n.message);
        else {
          if (!this.resumeWanted.has(n.runId)) this.resumeWanted.set(n.runId, []);
          void this.tryResume(n.runId);
        }
        break;
      }
    }
  }
}
