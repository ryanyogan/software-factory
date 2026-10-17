import { spawn } from 'node:child_process';
import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { apiClient } from '../client';
import { readConfig, resolveApiUrl } from '../config';
import { findLink } from '../context';
import { currentBranch } from '../git';
import { io } from '../output';

/** Opens `url` with xdg-open (macOS: open). Resolves false when no opener could be started. */
function openUrl(url: string): Promise<boolean> {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Web page for: a run id; else the current branch's task; else the linked project; else home. */
async function pageFor(runId: string | undefined, args: { api?: string }): Promise<string> {
  if (runId) return `/runs/${encodeURIComponent(runId)}`;
  const link = await findLink(process.cwd(), await readConfig());
  if (!link) return '/';
  const branch = await currentBranch(process.cwd());
  if (branch) {
    const { tasks } = await apiClient(args).call('task.list', { projectId: link.projectId });
    const task = tasks.find((t) => t.branch === branch);
    if (task) return `/tasks/${encodeURIComponent(task.id)}`;
  }
  return `/projects/${encodeURIComponent(link.projectId)}`;
}

export default defineCommand({
  meta: { name: 'open', description: 'Open a run (or this repo’s task/project) in the browser' },
  args: {
    ...globalArgs,
    runId: { type: 'positional', required: false, description: 'Run id' },
  },
  async run({ args }) {
    try {
      // The web app serves the API (/v1/*), so the API URL is also the web URL (SF_WEB_URL overrides).
      const base = (process.env.SF_WEB_URL || resolveApiUrl(args.api)).replace(/\/+$/, '');
      const url = `${base}${await pageFor(args.runId || undefined, args)}`;
      const opened = process.env.SF_NO_BROWSER ? false : await openUrl(url);
      if (args.json) io.out(JSON.stringify({ url, opened }));
      else io.out(opened ? `Opened ${url}` : url);
    } catch (e) {
      io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  },
});
