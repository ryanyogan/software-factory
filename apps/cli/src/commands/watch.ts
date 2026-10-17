import { defineCommand } from 'citty';
import { globalArgs } from '../args';
import { readConfig, resolveApiUrl } from '../config';
import { io } from '../output';
import { eventsUrl, formatEvent, isTerminalEvent, type RunEventMessage } from '../watch';

export default defineCommand({
  meta: { name: 'watch', description: "Stream a run's events (WebSocket)" },
  args: {
    ...globalArgs,
    runId: { type: 'positional', required: true, description: 'Run id' },
    since: { type: 'string', description: 'Replay events after this seq (default 0 = all)' },
  },
  async run({ args }) {
    const token = process.env.SF_TOKEN || (await readConfig()).token;
    const url = eventsUrl(resolveApiUrl(args.api), args.runId, Number(args.since ?? 0) || 0);
    // Node's WebSocket (undici) accepts `headers`; no Origin is sent, so the API requires
    // Bearer (or the localhost dev bypass) — cookies are never used for CLI sockets.
    const init = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    const ws = new WebSocket(url, init as unknown as string[]);
    await new Promise<void>((resolve) => {
      ws.addEventListener('open', () => {
        if (!args.json) io.err(`watching ${args.runId} (ctrl-c to stop)`);
      });
      ws.addEventListener('message', (m) => {
        const text = String(m.data);
        if (text === 'pong') return;
        let event: RunEventMessage;
        try {
          event = JSON.parse(text) as RunEventMessage;
        } catch {
          return;
        }
        io.out(args.json ? JSON.stringify(event) : formatEvent(event));
        if (isTerminalEvent(event)) ws.close();
      });
      ws.addEventListener('error', () => {
        io.err(`error: could not connect to ${url}`);
        process.exitCode = 1;
      });
      ws.addEventListener('close', () => resolve());
      process.once('SIGINT', () => ws.close());
    });
  },
});
