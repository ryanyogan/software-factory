import type { CommandInput, Run } from '@sf/contract';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { callCommand, viewerFn } from './commands';

/** Query keys mirror command names so invalidation reads like the contract. */
export const keys = {
  projects: ['project.list'] as const,
  tasks: (projectId?: string) => ['task.list', projectId ?? null] as const,
  runs: (taskId?: string) => ['run.list', taskId ?? null] as const,
  run: (id: string) => ['run.get', id] as const,
  events: (runId: string) => ['run.events', runId] as const,
};

export const viewerQuery = () =>
  queryOptions({ queryKey: ['viewer'], queryFn: () => viewerFn(), staleTime: 60_000 });

export const projectsQuery = () =>
  queryOptions({ queryKey: keys.projects, queryFn: () => callCommand('project.list', {}) });

export const tasksQuery = (projectId?: string) =>
  queryOptions({
    queryKey: keys.tasks(projectId),
    queryFn: () => callCommand('task.list', projectId ? { projectId } : {}),
  });

export const runsQuery = (taskId?: string) =>
  queryOptions({
    queryKey: keys.runs(taskId),
    queryFn: () => callCommand('run.list', taskId ? { taskId } : {}),
  });

export const runQuery = (id: string) =>
  queryOptions({ queryKey: keys.run(id), queryFn: () => callCommand('run.get', { id }) });

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CommandInput<'project.create'>) => callCommand('project.create', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CommandInput<'task.create'>) => callCommand('task.create', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['task.list'] }),
  });
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CommandInput<'run.start'>) => callCommand('run.start', input),
    onSuccess: (run: Run) => {
      qc.setQueryData(keys.run(run.id), run);
      return qc.invalidateQueries({ queryKey: ['run.list'] });
    },
  });
}

/** Run states that need a human (Phase 0 "Needs you"). */
export const NEEDS_YOU: ReadonlySet<Run['state']> = new Set(['queued', 'blocked', 'review']);
