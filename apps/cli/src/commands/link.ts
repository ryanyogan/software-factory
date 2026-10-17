import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { apiClient } from '../client';
import { readConfig, updateConfig } from '../config';
import { chooseProject } from '../context';
import { mainRepoRoot } from '../git';
import { action, table } from '../output';

async function repoRootOrThrow(): Promise<string> {
  const root = await mainRepoRoot(process.cwd());
  if (!root) throw new Error('not inside a git repository');
  return root;
}

export const link = defineCommand({
  meta: { name: 'link', description: 'Link this git repo to a project (for sf daemon / sf run)' },
  args: {
    ...globalArgs,
    project: {
      type: 'string',
      description: 'Project id (default: the project whose repo matches the origin remote)',
    },
    list: { type: 'boolean', description: 'List linked repos' },
  },
  run: ({ args }) => {
    if (args.list) {
      return action(
        args,
        async () => {
          const links = (await readConfig()).links ?? {};
          return {
            links: Object.entries(links).map(([repo, l]) => ({ repo, ...l })),
          };
        },
        (d) =>
          table(d.links, [
            ['project', (l) => l.projectId],
            ['repo', (l) => l.repo],
          ]),
      );
    }
    return action(
      args,
      async () => {
        const repo = await repoRootOrThrow();
        const { projects } = await apiClient(args).call('project.list', {});
        const project = await chooseProject({ repoRoot: repo, projectId: args.project, projects });
        await updateConfig((c) => ({
          ...c,
          links: {
            ...c.links,
            [repo]: { projectId: project.id, linkedAt: new Date().toISOString() },
          },
        }));
        return { repo, projectId: project.id, name: project.name };
      },
      (d) => `Linked ${d.repo} → ${d.projectId} (${d.name})`,
    );
  },
});

export const unlink = defineCommand({
  meta: { name: 'unlink', description: 'Remove the link of this git repo' },
  args: { ...globalArgs },
  run: ({ args }) =>
    action(
      args,
      async () => {
        const repo = await repoRootOrThrow();
        let projectId: string | undefined;
        await updateConfig((c) => {
          projectId = c.links?.[repo]?.projectId;
          const links = { ...c.links };
          delete links[repo];
          return { ...c, links };
        });
        return { repo, projectId: projectId ?? null };
      },
      (d) => (d.projectId ? `Unlinked ${d.repo} (was ${d.projectId})` : `${d.repo} was not linked`),
    ),
});
