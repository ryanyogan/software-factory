// Manual smoke run of a REAL adapter (spends tokens on your subscription). Not a test.
//   pnpm --filter @sf/adapters smoke <claude-code|codex> <scratch-dir> [--record]
// Creates a throwaway git repo under <scratch-dir>, runs a trivial prompt, sends a follow-up
// mid-turn (on the first tool call), ends the session, then resumes it for one more short turn.
// --record writes the raw SDK messages to fixtures/<agent>/smoke.jsonl (redacted).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@sf/contract';
import { createClaudeCodeAdapter } from '../src/claude-code/index';
import { createCodexAdapter } from '../src/codex/index';
import type { AgentAdapter, AgentResult, AgentSession } from '../src/types';

const [agent, scratch, flag] = process.argv.slice(2);
if ((agent !== 'claude-code' && agent !== 'codex') || !scratch) {
  console.error('usage: smoke.ts <claude-code|codex> <scratch-dir> [--record]');
  process.exit(2);
}

const raw: { phase: string; t: number; msg: unknown }[] = [];
let phase = 'run1';
const t0 = Date.now();
const tee = (msg: unknown) => raw.push({ phase, t: Date.now() - t0, msg });

const adapter: AgentAdapter =
  agent === 'claude-code'
    ? createClaudeCodeAdapter({
        loadSdk: async () => {
          const sdk = await import('@anthropic-ai/claude-agent-sdk');
          const query: typeof sdk.query = (params) => {
            const q = sdk.query(params);
            const iter = (async function* () {
              for await (const m of q) {
                tee(m);
                yield m;
              }
            })();
            return Object.assign(iter, {
              close: () => q.close(),
              interrupt: () => q.interrupt(),
            }) as unknown as ReturnType<typeof sdk.query>;
          };
          return { query };
        },
      })
    : createCodexAdapter({
        createCodex: async (options) => {
          const { Codex } = await import('@openai/codex-sdk');
          const codex = new Codex(options);
          const wrap = (thread: ReturnType<typeof codex.startThread>) => ({
            get id() {
              return thread.id;
            },
            async runStreamed(input: string, t?: Parameters<typeof thread.runStreamed>[1]) {
              const { events } = await thread.runStreamed(input, t);
              return {
                events: (async function* () {
                  for await (const e of events) {
                    tee(e);
                    yield e;
                  }
                })(),
              };
            },
          });
          return {
            startThread: (o) => wrap(codex.startThread(o)),
            resumeThread: (id, o) => wrap(codex.resumeThread(id, o)),
          };
        },
      });

const repo = join(scratch, `smoke-${agent}-${Date.now()}`);
mkdirSync(repo, { recursive: true });
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# smoke\n');
git('add', '-A');
git('-c', 'user.name=sf', '-c', 'user.email=sf@localhost', 'commit', '-qm', 'init');

const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const short = (e: AgentEvent) => JSON.stringify(e).slice(0, 220);

async function drive(s: AgentSession, followUp?: string): Promise<AgentResult> {
  const timer = setTimeout(() => {
    log('TIMEOUT: cancelling');
    s.cancel();
  }, 240_000);
  let sent = false;
  for await (const ev of s.events) {
    log('event', short(ev));
    if (followUp && !sent && ev.type === 'tool.call') {
      sent = true;
      log('>>> send follow-up (mid-turn)');
      s.send(followUp);
    }
    if (ev.type === 'turn.completed') {
      log(`turn.completed; idle=${s.idle}`);
      if (s.idle && (!followUp || sent)) s.end();
    }
  }
  clearTimeout(timer);
  return s.result;
}

const run1 = await adapter.start({
  cwd: repo,
  prompt:
    'Create a file hello.txt containing exactly the text "hi" (no trailing newline needed), then stop. Do nothing else.',
  onStderr: (d) => process.stderr.write(`[stderr] ${d}`),
});
const r1 = await drive(run1, 'Also create bye.txt containing exactly "bye". Then stop.');
log('RESULT 1', JSON.stringify(r1));
log(
  'files',
  readdirSync(repo).filter((f) => f !== '.git'),
);
log('git status', git('status', '--porcelain').trim());

let r2: AgentResult | null = null;
if (r1.sessionId && !flag?.includes('no-resume')) {
  phase = 'resume';
  const run2 = await adapter.start({
    cwd: repo,
    prompt: 'Reply with just the word ok. Do not use any tools.',
    resumeSessionId: r1.sessionId,
    ...(agent === 'claude-code' ? { costBaseUsd: r1.costUsd ?? 0 } : {}),
  });
  r2 = await drive(run2);
  log('RESULT 2 (resume)', JSON.stringify(r2));
}

const results = raw.filter((r) => (r.msg as { type?: string }).type === 'result');
log(
  'raw result messages:',
  results.map((r) => {
    const m = r.msg as Record<string, unknown>;
    return {
      phase: r.phase,
      subtype: m.subtype,
      total_cost_usd: m.total_cost_usd,
      num_turns: m.num_turns,
      queued_turn_count: m.queued_turn_count,
      user_message_uuids: m.user_message_uuids,
      usage: m.usage,
    };
  }),
);
const init = raw.find((r) => (r.msg as { subtype?: string }).subtype === 'init');
if (init) log('init apiKeySource:', (init.msg as { apiKeySource?: string }).apiKeySource);

if (flag === '--record') {
  const home = homedir();
  const SENSITIVE = /email|organization|account|org_?id|user_?id|token|secret|api_?key$/i;
  /** Machine/account inventory the mapper never reads. */
  const DROP_KEYS = new Set([
    'mcp_servers',
    'memory_paths',
    'plugins',
    'skills',
    'agents',
    'slash_commands',
  ]);
  const user = home.split('/').pop() ?? '';
  const redact = (v: unknown, key = ''): unknown => {
    if (DROP_KEYS.has(key)) return Array.isArray(v) ? [] : '<redacted>';
    if (typeof v === 'string') {
      if (SENSITIVE.test(key)) return '<redacted>';
      const s = v.split(scratch).join('<scratch>').split(home).join('~');
      return user ? s.split(user).join('user') : s;
    }
    if (Array.isArray(v)) return v.map((x) => redact(x));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
    }
    return v;
  };
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', agent, 'smoke.jsonl');
  mkdirSync(dirname(out), { recursive: true });
  const kept = raw.filter((r) => (r.msg as { type?: string }).type !== 'rate_limit_event');
  writeFileSync(out, kept.map((r) => JSON.stringify(redact(r))).join('\n') + '\n');
  log('recorded', raw.length, 'messages →', out);
}
log('repo', repo);
process.exit(r1.ok ? 0 : 1);
