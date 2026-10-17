import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { configPath, dataDir, readConfig, resolveApiUrl, updateConfig } from '../config';
import { io } from '../output';

/** The machine id, generated and persisted on first use. */
export async function ensureMachineId(): Promise<string> {
  const config = await readConfig();
  if (config.machineId) return config.machineId;
  const machineId = `mch_${randomUUID().replaceAll('-', '')}`;
  await updateConfig((c) => ({ ...c, machineId: c.machineId ?? machineId }));
  return (await readConfig()).machineId ?? machineId;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One daemon per machine (per config dir): a pid file next to config.json. */
async function lock(): Promise<() => Promise<void>> {
  const file = join(dirname(configPath()), 'daemon.pid');
  const old = Number(await readFile(file, 'utf8').catch(() => ''));
  if (old && old !== process.pid && alive(old)) {
    throw new Error(`sf daemon is already running (pid ${old}, ${file})`);
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${process.pid}\n`);
  return () => rm(file, { force: true });
}

const ts = () => new Date().toISOString().slice(11, 23);

export default defineCommand({
  meta: {
    name: 'daemon',
    description: 'Run queued local runs of linked repos (foreground; ctrl-c stops)',
  },
  args: {
    ...globalArgs,
    'max-concurrency': {
      type: 'string',
      description: 'Runs at once (default: config daemon.maxConcurrency or 2)',
    },
    'pr-provider': {
      type: 'string',
      description: 'gh | fake | none (default: env SF_PR_PROVIDER, config daemon.prProvider, gh)',
    },
  },
  async run({ args }) {
    const log = (msg: string) => io.err(`${ts()} ${msg}`);
    try {
      const unlock = await lock();
      const machineId = await ensureMachineId();
      const config = await readConfig();
      const links = Object.entries(config.links ?? {});
      if (!links.length) throw new Error('no linked repos: run `sf link` inside a repo first');
      const token = process.env.SF_TOKEN || config.token;
      const apiUrl = resolveApiUrl(args.api);
      const prName =
        args['pr-provider'] || process.env.SF_PR_PROVIDER || config.daemon?.prProvider || 'gh';
      const max = Number(args['max-concurrency'] ?? config.daemon?.maxConcurrency ?? 2) || 2;
      // Loaded only when the daemon actually starts (keeps `sf --help` cold start small).
      // Agent SDKs load later still: only when a session for that agent starts.
      const [{ Daemon }, { nodeTransport }, { selectPrProvider }, { apiClient }, { startAgent }] =
        await Promise.all([
          import('../daemon/daemon'),
          import('../daemon/socket'),
          import('../pr'),
          import('../client'),
          import('@sf/adapters'),
        ]);
      const daemon = new Daemon({
        transport: nodeTransport({ apiUrl, client: apiClient(args), token, machineId }),
        machineId,
        userId: token ? config.user?.id : undefined,
        dataDir: dataDir(),
        prProvider: selectPrProvider(prName),
        startAgent,
        maxConcurrency: max,
        projects: new Map(links.map(([repo, l]) => [l.projectId, repo])),
        log,
      });
      log(
        `sf daemon ${machineId} → ${apiUrl} (${links.length} repo(s), max ${max}, PRs: ${prName})`,
      );
      let stopping = false;
      const stop = (sig: string) => {
        if (stopping) {
          log('forced exit');
          process.exit(130);
        }
        stopping = true;
        log(`${sig}: stopping (cancelling running agents; again to force)`);
        void daemon
          .stop()
          .then(unlock)
          .then(() => {
            log('stopped');
            process.exit(0);
          });
      };
      process.on('SIGINT', () => stop('SIGINT'));
      process.on('SIGTERM', () => stop('SIGTERM'));
      await daemon.start();
      // Keep the process alive; the sockets' timers do too, but be explicit.
      setInterval(() => undefined, 1 << 30);
    } catch (e) {
      io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  },
});
