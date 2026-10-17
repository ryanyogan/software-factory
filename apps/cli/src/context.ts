import type { Client, Project, Task } from '@sf/contract';
import type { SfConfig } from './config';
import { currentBranch, mainRepoRoot, normalizeRepoUrl, remoteUrl } from './git';

/*
 * Context resolution for commands run inside a git repo:
 *   cwd → main repo root (also from inside a task worktree) → linked project (`sf link`)
 *   current branch → the project's task with that branch.
 */

export class ContextError extends Error {}

export interface LinkedRepo {
  repoRoot: string;
  projectId: string;
}

/** The linked project for the repo containing `cwd`, or null (not a repo / not linked). */
export async function findLink(cwd: string, config: SfConfig): Promise<LinkedRepo | null> {
  const repoRoot = await mainRepoRoot(cwd);
  if (!repoRoot) return null;
  const link = config.links?.[repoRoot];
  return link ? { repoRoot, projectId: link.projectId } : null;
}

/** Projects whose `repoUrl` is the same repo as `remote` (normalized host/owner/name). */
export function projectsForRemote(remote: string, projects: readonly Project[]): Project[] {
  const want = normalizeRepoUrl(remote);
  return projects.filter((p) => p.repoUrl !== null && normalizeRepoUrl(p.repoUrl) === want);
}

/** Which project `sf link` should link `repoRoot` to. */
export async function chooseProject(opts: {
  repoRoot: string;
  projectId?: string;
  projects: readonly Project[];
}): Promise<Project> {
  if (opts.projectId) {
    const p = opts.projects.find((x) => x.id === opts.projectId);
    if (!p) throw new ContextError(`project ${opts.projectId} not found (see \`sf project list\`)`);
    return p;
  }
  const remote = await remoteUrl(opts.repoRoot);
  if (!remote) {
    throw new ContextError(
      'this repo has no `origin` remote to match against a project; pass --project ID',
    );
  }
  const matches = projectsForRemote(remote, opts.projects);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new ContextError(
      `no project has repo ${remote}; pass --project ID or create one: sf project create --name NAME --repo ${remote}`,
    );
  }
  throw new ContextError(
    `several projects have repo ${remote} (${matches.map((p) => p.id).join(', ')}); pass --project ID`,
  );
}

export interface RunTarget {
  taskId: string;
  /** Set when the task was created by this resolution (`--title`). */
  created?: Task;
}

/**
 * Task for `sf run start`: `--task` as given; else (inside a linked repo) `--title` creates a task in
 * the linked project, or the task whose branch is the current branch.
 */
export async function resolveRunTarget(opts: {
  cwd: string;
  config: SfConfig;
  client: Client;
  task?: string;
  title?: string;
}): Promise<RunTarget> {
  if (opts.task) return { taskId: opts.task };
  const link = await findLink(opts.cwd, opts.config);
  if (!link) {
    throw new ContextError(
      'pass --task ID, or run inside a repo linked with `sf link` (then --title creates a task)',
    );
  }
  if (opts.title) {
    const created = await opts.client.call('task.create', {
      projectId: link.projectId,
      title: opts.title,
    });
    return { taskId: created.id, created };
  }
  const branch = await currentBranch(opts.cwd);
  const { tasks } = await opts.client.call('task.list', { projectId: link.projectId });
  const task = branch ? tasks.find((t) => t.branch === branch) : undefined;
  if (!task) {
    throw new ContextError(
      `no task in ${link.projectId} uses branch ${branch ?? '(detached)'}; pass --title "..." to create one, or --task ID`,
    );
  }
  return { taskId: task.id };
}
