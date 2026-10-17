# Phase 1 research (stage 7, 2026-10-17)

Sources: installed `.d.ts`/`.js` of each package (installed in a scratch dir, not the repo), Context7
(`/websites/code_claude_en_agent-sdk`, `/openai/codex`), Cloudflare docs (developers.cloudflare.com `.md` pages),
and live probes on this machine. Where `.d.ts` and docs disagree, `.d.ts` wins. **UNVERIFIED** = not checked.

## 0. Versions (all checked 2026-10-17 with `npm view` / `--version`)

| Thing | Version | Notes |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | **0.3.302** (latest = next) | `claudeCodeVersion: 2.1.302`, same as local `claude` |
| `@openai/codex-sdk` | **0.163.0** (latest) | depends on `@openai/codex@0.163.0`; local `codex-cli 0.163.0` |
| node | 24.22.0 | global `WebSocket` (undici) |
| git | 2.55.0 | |
| gh | 2.102.0 | |
| drizzle-orm (repo) | 0.45.4 | |

Install (stage 9, in `packages/adapters`): `pnpm add @anthropic-ai/claude-agent-sdk@0.3.302 @openai/codex-sdk@0.163.0`.
Claude SDK peer deps: `@anthropic-ai/sdk >=0.93.0` (types only for us: `BetaMessage`, `MessageParam`),
`@modelcontextprotocol/sdk ^1.29.0`, `zod ^4` (repo already has zod 4). Add `@anthropic-ai/sdk` as a devDependency for types.

**Big gotcha – binaries and bundling.** Both SDKs ship the agent as a native binary in a platform optional dependency:
`@anthropic-ai/claude-agent-sdk-linux-x64` (273 MB) and `@openai/codex-linux-x64` (411 MB). Both resolve their
binary at runtime via `require.resolve` of their own package. So:
- The CLI is bundled by tsdown with `deps.onlyBundle: ['citty','zod']`; the SDKs **must stay external** (real
  `dependencies` of `@sf/adapters`/`@sf/cli`, lazy `import()` only inside `sf daemon`, so `sf --help` stays ~30 ms).
- To avoid the 700 MB of binaries you can point at the locally installed CLIs instead:
  Claude `options.pathToClaudeCodeExecutable` (absolute path; resolve `which claude`), Codex
  `new Codex({ codexPathOverride })`. Recommended: prefer the local binary when found on PATH, fall back to the bundled
  one. Version skew risk: the SDK talks a control protocol to the CLI; keep versions aligned (they are today: 2.1.302 / 0.163.0).
- CI (`pnpm install --frozen-lockfile`) will download both platform packages. Acceptable; tests never spawn them.

## 1. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.302)

Import: `import { query, type SDKMessage, type SDKUserMessage, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'`.
(`/core` entry exists with the same `query()` but un-inlined peers; do not mix root and `/core` in one process.)

```ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>; // streaming-input mode only
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  accountInfo(): Promise<AccountInfo>;
  close(): void; // kill the subprocess; no more messages
  // ...many more control methods
}
```

Relevant `Options` keys (from `.d.ts`): `cwd`, `additionalDirectories`, `permissionMode`, `allowDangerouslySkipPermissions`,
`permissionPrompts?: 'host' | 'none'`, `canUseTool`, `allowedTools`, `disallowedTools`, `sandbox`, `abortController`,
`resume`, `sessionId` (custom UUID), `forkSession`, `continue`, `persistSession` (default true), `settingSources`
(omitted = all; `[]` = isolation; must include `'project'` to load CLAUDE.md), `env` (**replaces** the whole env when
set; spread `process.env`), `model`, `maxTurns`, `maxBudgetUsd`, `includePartialMessages`, `systemPrompt`,
`pathToClaudeCodeExecutable`, `stderr: (data) => void`, `hooks`, `mcpServers`.

`PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`.
- `acceptEdits`: auto-accepts file edits (in cwd + additionalDirectories); Bash etc. still ask.
- `dontAsk`: deny anything not pre-approved. `auto`: model classifier approves/denies.
- `bypassPermissions`: requires `allowDangerouslySkipPermissions: true`.
- `permissionPrompts: 'none'`: nobody answers prompts; anything that would prompt is denied immediately (Claude is told so).

**Recommended for unattended worktree runs** (my judgement, not a doc recommendation):
`permissionMode: 'acceptEdits'` + a `canUseTool` callback that allows Bash/other tools (the worktree is disposable and
the user started the run) but denies tool inputs whose paths resolve outside the worktree, + `disallowedTools` for
anything you never want (e.g. `WebFetch` optional). Do **not** leave prompts unanswered: either `canUseTool` (host
answers) or `permissionPrompts: 'none'` (denied). Optional hardening: `sandbox: { enabled: true, autoAllowBashIfSandboxed: true }`
(OS sandbox; UNVERIFIED that bubblewrap is available on this machine). `settingSources: ['project', 'local']` loads the
repo's CLAUDE.md/settings without the user's global hooks/statusline (trade-off: user's global permission rules are
ignored too). Set `env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'sf/0.0.0' }`.

```ts
type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string; toolUseID?: string; /*...*/
}) => Promise<PermissionResult>;
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

### Streaming input (follow-ups mid-run), interrupt, resume

Use an async-iterable prompt backed by a queue. The session stays alive while the iterable is open; each yielded user
message starts (or queues into) a turn. A `result` message ends each turn (seen in docs' examples; one `result` per
turn in streaming mode is **UNVERIFIED** live, verify in stage 9 smoke run).

```ts
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

function inbox() {
  const q: SDKUserMessage[] = []; let wake: (() => void) | null = null; let done = false;
  return {
    push(text: string) { q.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }); wake?.(); },
    end() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (q.length) yield q.shift()!;
        if (done) return;
        await new Promise<void>((r) => (wake = r)); wake = null;
      }
    },
  };
}

const input = inbox();
input.push(firstPrompt);
const abort = new AbortController();
const run = query({ prompt: input, options: {
  cwd: worktree, permissionMode: 'acceptEdits', canUseTool, abortController: abort,
  resume: previousSessionId /* optional, from an earlier run of this task */,
  env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'sf' },
}});
for await (const m of run) { /* map to AgentEvent (section 3) */ }
// follow-up: input.push('also add tests');   (SDKUserMessage.priority?: 'now'|'next'|'later' exists; semantics UNVERIFIED)
// stop current turn, keep session: await run.interrupt();
// cancel run: abort.abort() or run.close(); then input.end()
```

Resume: `options.resume = sessionId` (the `session_id` from any message). Sessions persist to `~/.claude/projects/...`
unless `persistSession: false` (then no resume). `forkSession: true` with `resume` branches instead of continuing.

### SDKMessage union (selected members, from `.d.ts`)

`SDKMessage` has ~40 members; we only need these, ignore the rest (`stream_event`, hooks, status, rate-limit, etc.):

```ts
type SDKSystemMessage = { type: 'system'; subtype: 'init'; session_id: string; uuid: UUID; cwd: string; model: string;
  tools: string[]; permissionMode: PermissionMode; apiKeySource: ApiKeySource; claude_code_version: string; /*...*/ };
type SDKAssistantMessage = { type: 'assistant'; message: BetaMessage; parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError; uuid: UUID; session_id: string; /*...*/ };
  // message.content: BetaContentBlock[]: {type:'text',text} | {type:'thinking',thinking} | {type:'tool_use',id,name,input} | ...
  // message.usage: per-API-call usage (input_tokens, output_tokens, cache_*). Prefer result.usage for totals.
type SDKUserMessage = { type: 'user'; message: MessageParam; parent_tool_use_id: string | null;
  tool_use_result?: unknown; isSynthetic?: boolean; session_id?: string; uuid?: UUID; /*...*/ };
  // tool results arrive as user messages: message.content = [{ type:'tool_result', tool_use_id, content: string | block[], is_error?: boolean }]
  // (SDKUserMessageReplay has the same shape and type:'user' — echoes of our own input; skip messages whose content is a plain string we sent)
type SDKResultMessage =
  | { type: 'result'; subtype: 'success'; is_error: boolean; result: string; num_turns: number; duration_ms: number;
      total_cost_usd: number; usage: NonNullableUsage; modelUsage: Record<string, ModelUsage>; session_id: string; stop_reason: string | null; /*...*/ }
  | { type: 'result'; subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
      is_error: boolean; errors: string[]; total_cost_usd: number; usage: NonNullableUsage; session_id: string; /*...*/ };
```
`parent_tool_use_id !== null` = message from a subagent (Task tool); include it but tag it, or skip in v1.
`total_cost_usd` is cumulative for the query (UNVERIFIED whether per turn or session-cumulative; doc comment says
consumers "difference the cumulative costUSD per turn" → treat as cumulative and emit deltas).

### Binary + auth — VERIFIED live
- The SDK spawns its **bundled** native `claude` (optional dep), or `pathToClaudeCodeExecutable` if set. It does not need
  the user's `claude` on PATH.
- Auth: probe with `ANTHROPIC_API_KEY` removed from `env`, prompt = never-yielding iterable (no API call, no tokens),
  `await q.accountInfo()` → `{ subscriptionType: 'Claude Max', apiProvider: 'firstParty', organization: … }`.
  **It reuses the local Claude Code login (~/.claude OAuth). No API key needed.** If `ANTHROPIC_API_KEY` is set in the
  daemon's env it takes precedence (init message `apiKeySource` tells which) — strip it unless the user opts in.

## 2. Codex SDK (`@openai/codex-sdk` 0.163.0)

Import: `import { Codex, type Thread, type ThreadEvent, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk'`.

```ts
type CodexOptions = { codexPathOverride?: string; baseUrl?: string; apiKey?: string;
  config?: CodexConfigObject; configOverrides?: string[]; env?: Record<string, string> /* REPLACES process.env */ };
type ThreadOptions = { model?: string; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  workingDirectory?: string; skipGitRepoCheck?: boolean; approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  modelReasoningEffort?: ...; networkAccessEnabled?: boolean; webSearchMode?: 'disabled'|'cached'|'live';
  additionalDirectories?: string[]; threadSource?: string };
type TurnOptions = { signal?: AbortSignal; outputSchema?: unknown };
class Codex { constructor(o?: CodexOptions); startThread(o?: ThreadOptions): Thread; resumeThread(id: string, o?: ThreadOptions): Thread }
class Thread { get id(): string | null /* set after thread.started */;
  run(input: Input, t?: TurnOptions): Promise<{ items: ThreadItem[]; finalResponse: string; usage: Usage | null }>; // throws on turn.failed
  runStreamed(input: Input, t?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }> }
type Input = string | ({ type: 'text'; text: string } | { type: 'local_image'; path: string })[];
```

**How it works (read from `dist/index.js`)**: every `run`/`runStreamed` call spawns a fresh
`codex exec --experimental-json [--model M] [--sandbox S] [--cd DIR] [--skip-git-repo-check] [--config approval_policy="…"] [resume <threadId>]`,
writes the prompt to stdin, closes stdin, and parses JSONL from stdout. Non-zero exit → throws
`Codex Exec exited with code N: <stderr>`. `signal` is passed to `child_process.spawn` (abort = SIGTERM to the child).

Consequences:
- **No mid-turn steering.** A follow-up = wait for (or abort) the current turn, then `thread.runStreamed(followUp)` on the
  same `Thread` (it passes `resume <id>`). Or later: `codex.resumeThread(threadId, sameOptions)`.
- Cancel = `AbortController` per turn (`{ signal }`).
- Unattended worktree: `{ workingDirectory: worktree, sandboxMode: 'workspace-write', approvalPolicy: 'never', skipGitRepoCheck: true }`.
  `workspace-write` = writes limited to cwd (+additionalDirectories); `networkAccessEnabled` default off in workspace-write
  (UNVERIFIED default). Worktrees are git repos, so skipGitRepoCheck is only a safety net.
- Binary: bundled `@openai/codex` → `@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`, or `codexPathOverride`.
- Auth: SDK only sets `CODEX_API_KEY` if `apiKey` given; otherwise the CLI uses `~/.codex/auth.json`
  (`codex login status` here → "Logged in using ChatGPT"). Context7 source confirms. **No API key needed.** Not live-tested
  with a real turn (would spend tokens); `codex exec --experimental-json` was confirmed to parse (hidden flag).
- User's `~/.codex/config.toml` (model `gpt-6-astra`, effort high) applies to SDK runs unless overridden.

### ThreadEvent / ThreadItem (from `.d.ts`, complete)

```ts
type ThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: Usage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: ThreadItem }
  | { type: 'error'; message: string };
type Usage = { input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number };
type ThreadItem =
  | { id: string; type: 'agent_message'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'command_execution'; command: string; aggregated_output: string; exit_code?: number; status: 'in_progress'|'completed'|'failed' }
  | { id: string; type: 'file_change'; changes: { path: string; kind: 'add'|'delete'|'update' }[]; status: 'completed'|'failed' }
  | { id: string; type: 'mcp_tool_call'; server: string; tool: string; arguments: unknown;
      result?: { content: ContentBlock[]; structured_content: unknown }; error?: { message: string }; status: 'in_progress'|'completed'|'failed' }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'todo_list'; items: { text: string; completed: boolean }[] }
  | { id: string; type: 'error'; message: string };
```
No cost in Codex events (ChatGPT plan): `costUsd` stays undefined. `.d.ts` imports `ContentBlock` from
`@modelcontextprotocol/sdk/types.js` — add `@modelcontextprotocol/sdk` (already a Claude SDK peer) or `skipLibCheck`.

## 3. Normalized `AgentEvent` (proposal for `@sf/contract`)

```ts
import { z } from 'zod';
const usage = z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(),
  cachedInputTokens: z.number().int().optional(), costUsd: z.number().optional() /* delta for this turn */ });
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.started'), sessionId: z.string(), model: z.string().optional(), cwd: z.string().optional() }),
  z.object({ type: z.literal('message'), role: z.enum(['assistant', 'user']), text: z.string(), itemId: z.string().optional() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),                       // optional to show
  z.object({ type: z.literal('tool.call'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool.result'), id: z.string(), output: z.string(), isError: z.boolean() }),
  z.object({ type: z.literal('file.change'), changes: z.array(z.object({ path: z.string(), kind: z.enum(['add', 'delete', 'update']) })) }),
  z.object({ type: z.literal('todo'), items: z.array(z.object({ text: z.string(), done: z.boolean() })) }),
  z.object({ type: z.literal('turn.completed'), usage: usage.optional(), isError: z.boolean().default(false), result: z.string().optional() }),
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean().default(false) }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
```
Cap `tool.result.output` (e.g. 16 KiB, mark truncated) before sending to the RunLog; DO messages max 32 MiB but the
GUI does not need full logs. The daemon wraps each AgentEvent as a RunEvent `{ type: 'agent.<type>', payload }` (or a
single `type: 'agent'` with the event as payload — pick one in stage 8) and stamps `emittedAt` (ms) for latency.

| AgentEvent | Claude SDK source | Codex SDK source |
|---|---|---|
| session.started | `system`/`init`: `session_id`, `model`, `cwd` | `thread.started`: `thread_id` |
| message(assistant) | `assistant` → each `content[]` `{type:'text'}` | `item.completed` `agent_message.text` |
| message(user) | our own pushed follow-up (emit from daemon, not SDK echo) | same |
| reasoning | `assistant` content `{type:'thinking'}` | `item.completed` `reasoning` |
| tool.call | `assistant` content `{type:'tool_use', id, name, input}` | `item.started` `command_execution` → `{id, name:'shell', input:{command}}`; `mcp_tool_call` → `{name: server+'.'+tool, input: arguments}`; `web_search` → `{name:'web_search', input:{query}}` |
| tool.result | `user` content `{type:'tool_result', tool_use_id, content, is_error}` | `item.completed` `command_execution` → `output: aggregated_output`, `isError: status==='failed' \|\| exit_code!==0`; `mcp_tool_call` → result/error |
| file.change | (derive: `tool_use` name in `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, `input.file_path`; or rely on diff.snapshot) | `item.completed` `file_change.changes` |
| todo | `tool_use` name `TodoWrite` input.todos (optional) | `todo_list` items |
| turn.completed | `result`: `usage.input_tokens/output_tokens`, `total_cost_usd` (delta vs previous), `is_error`, `result` | `turn.completed`: `usage` (no cost) |
| error | `result` with error subtype → `errors.join('\n')`; `assistant.error` | `turn.failed.error.message` (fatal for turn), `error` event, `item` type `error` |

Ignore `item.updated` (Codex) and `stream_event` (Claude, only with `includePartialMessages`) in v1.

Adapter interface suggestion (stage 9):
```ts
interface AgentSession { events: AsyncIterable<AgentEvent>; send(text: string): Promise<void>; interrupt(): Promise<void>; cancel(): Promise<void>; }
interface AgentAdapter { start(opts: { cwd: string; prompt: string; resumeSessionId?: string; signal?: AbortSignal }): AgentSession }
```
Claude: `send` = `inbox.push`. Codex: `send` = enqueue; when the current turn ends, run the next `runStreamed` on the same
Thread (optionally `interrupt` = abort current turn then run the follow-up). Session ends when the inbox is closed
and idle.

## 4. Cloudflare (api: Hono + `RunLog`/`ProjectRoom` SQLite DOs, compat date 2026-10-01)

Current state (read `apps/api/src`): both DOs `ctx.acceptWebSocket(server)` in `fetch()`; `RunLog.append()` (RPC)
broadcasts to all sockets; `webSocketMessage` only answers `ping`. Routes: `GET /v1/runs/:id/events` → RunLog,
`GET /v1/projects/:id/room` → ProjectRoom, both behind `requireWsUser`.

Hibernation API (docs: best-practices/websockets, api/state):
- `ctx.acceptWebSocket(ws, tags?: string[])` — max 10 tags x 256 chars; `ctx.getWebSockets(tag?)`; `ctx.getTags(ws)`.
- Client messages arrive in `webSocketMessage(ws, message: string | ArrayBuffer)`; the constructor re-runs after hibernation,
  so per-socket state must come from `ws.deserializeAttachment()`.
- `ws.serializeAttachment(value)` — structured-clone, **max 16,384 bytes**, survives hibernation, lost on close; call again
  after changing it. `deserializeAttachment()` returns `null` if never set.
- `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))` answers pings without waking the DO
  (replace the manual ping handler).
- compat ≥ 2026-04-07 enables `web_socket_auto_reply_to_close`: `webSocketClose` need not call `ws.close()`.
- `webSocketClose(ws, code, reason, wasClean)`, `webSocketError(ws, error)`.

Pattern for the daemon socket on RunLog (role + identity in tags + attachment, set in the Worker after auth, passed
as headers to the DO since the DO cannot see the session):

```ts
// Worker route (after requireWsUser): forward identity to the DO
const req = new Request(c.req.raw); req.headers.set('x-sf-user', userId); req.headers.set('x-sf-role', role); // 'viewer' | 'daemon'
return c.env.RUN_LOG.getByName(runId).fetch(req);

// RunLog.fetch
const role = request.headers.get('x-sf-role') === 'daemon' ? 'daemon' : 'viewer';
const { 0: client, 1: server } = new WebSocketPair();
this.ctx.acceptWebSocket(server, [role]);
server.serializeAttachment({ role, userId: request.headers.get('x-sf-user'), since });

// RunLog.webSocketMessage
override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
  const att = ws.deserializeAttachment() as { role: 'viewer' | 'daemon'; userId: string } | null;
  const msg = ClientMsg.safeParse(JSON.parse(String(raw)));       // zod; ignore/close on bad input
  if (!att || !msg.success) return;
  if (att.role === 'daemon' && msg.data.kind === 'events') for (const e of msg.data.events) await this.append(e); // batch
  // viewers' follow-up/cancel should go through contract commands (run.message / run.cancel) → RunLog RPC →
  for (const d of this.ctx.getWebSockets('daemon')) d.send(JSON.stringify({ kind: 'control', ... }));
}
```
Strip any client-supplied `x-sf-*` headers in the Worker before setting them. Recommended: viewers send follow-ups via
the command API (one API for all surfaces), and the DO only relays `control` frames to `getWebSockets('daemon')`.
If no daemon socket is connected, store the follow-up as an event; the daemon replays `since` on reconnect.

ProjectRoom broadcast (daemon subscribes per linked project; core/api calls it after `run.start` with location local):
```ts
async broadcast(msg: unknown, tag?: string): Promise<number> {
  const s = JSON.stringify(msg); let n = 0;
  for (const ws of this.ctx.getWebSockets(tag)) { try { ws.send(s); n++; } catch {} }
  return n;
}
// from the api handler (EventsPort-like port in core): await env.PROJECT_ROOM.getByName(projectId).broadcast({ kind: 'run.queued', runId }, 'daemon');
```
Note: the current ProjectRoom relays every client message to all peers — replace with explicit message kinds.
`getWebSockets` may include CLOSING sockets; wrap `send` in try/catch (already done in RunLog).
DO-to-DO/Worker RPC: `stub.broadcast(...)` is a normal RPC call; local dev caveat from stage 4 still applies
(5173 and 8787 have separate DO socket sets — use one server per flow).

### Atomic claim in D1 via drizzle — VERIFIED (libsql, same drizzle 0.45.4 SQLite builder)
```ts
const [claimed] = await db.update(runs)
  .set({ state: 'running', claimedBy: daemonId, startedAt: now })
  .where(and(eq(runs.id, runId), eq(runs.state, 'queued')))
  .returning();
if (!claimed) throw new CommandError('conflict', 'run already claimed');
```
Generated SQL: `update "runs" set ... where ("runs"."id" = ? and "runs"."state" = ?) returning ...`; second claim
returned `[]`. D1 driver (`drizzle-orm/d1/session.js`) implements `all()`/`values()` for returning queries; D1 is
SQLite ≥ 3.35 so `RETURNING` works (D1 live UNVERIFIED but standard). A single statement is atomic in D1; no
transaction needed.
Schema gaps for stage 8: `runs.state` enum has no `failed`; no `claimedBy`, `sessionId`, `prUrl`, `branch`/`baseSha`,
`costUsd`. Drizzle `text({ enum })` is type-only (no CHECK), so adding `failed` needs no SQL; new columns are plain
`ALTER TABLE ADD COLUMN` — check the generated migration is not a table rebuild (stage 6 gotcha: rebuild cascades deletes).

## 5. Git worktrees from Node (`node:child_process` `execFile`, no deps) — VERIFIED on git 2.55

```ts
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
const pexec = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  pexec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })
    .then((r) => r.stdout.trimEnd());
```
- **Default branch**: `git symbolic-ref --short refs/remotes/origin/HEAD` → `origin/main` (strip `origin/`); fails with
  "not a symbolic ref" when there is no remote/HEAD (verified) → fall back to `git rev-parse --abbrev-ref HEAD` of the main
  checkout, then `main`/`master` existence (`git show-ref --verify --quiet refs/heads/<b>`). (`git config init.defaultBranch`
  is a user default, not the repo's — don't use.)
- **Branch exists?** `git show-ref --verify --quiet refs/heads/<branch>` (exit 0/1).
- **Create**: `git worktree add -b <branch> <path> <base>` (new branch from base). Fails with
  `fatal: a branch named '<b>' already exists` if it exists → use `git worktree add <path> <branch>`.
- **Reuse**: `git worktree list --porcelain` → blocks `worktree <path>\nHEAD <sha>\nbranch refs/heads/<b>`; if the
  task's path is already listed, reuse it. A branch can be checked out in only one worktree
  (`fatal: '<b>' is already used by worktree at …`) — so never check out a task branch in the main checkout too.
- **Base SHA** for diffs: record `git merge-base <base> HEAD` at creation (store on the run).
- **Diff incl. untracked, without touching the real index** (preferred; verified):
  ```sh
  T=$(mktemp); GIT_INDEX_FILE=$T git read-tree HEAD && GIT_INDEX_FILE=$T git add -A && GIT_INDEX_FILE=$T git diff --cached <baseSha>; rm $T
  ```
  In Node pass `env: { ...process.env, GIT_INDEX_FILE: tmp }`. Respects `.gitignore`. Alternative `git add -N .` +
  `git diff <base>` also works but mutates the worktree's index (status shows `A new.txt`) — ok since the daemon owns the
  worktree, but the temp-index way is side-effect free. `git diff --no-index` only compares two paths, not useful here.
  Add `--no-color --no-ext-diff`; `--binary` only if you need to apply it; cap size (e.g. 1 MiB, then `--stat` only).
- **Commit at run end**: `git add -A && git -c user.name=… -c user.email=… commit -m … ` (only if `git status --porcelain`
  non-empty; use the user's git identity by default, i.e. don't pass `-c` unless missing).
- **Cleanup**: `git worktree remove <path>` refuses dirty trees (verified) → `--force`; then `git worktree prune`. Branch
  stays (good: PR head). Delete with `git branch -D` only on abandon.
- Pitfalls: run git with `cwd` = main repo for worktree admin commands; paths absolute; `mkdir -p` parent first
  (`$XDG_DATA_HOME/sf/worktrees/<projectId>/<taskId>`); `execFile` rejects on non-zero exit (catch for `show-ref`); a
  fresh worktree has no `node_modules` (agents may need `pnpm install`); concurrent git commands on one repo can hit
  `index.lock` — serialize per repo in the daemon.

## 6. `gh` for PRs (gh 2.102.0, flags from `gh pr create --help`)

```sh
git push -u origin <branch>                    # push first, so gh never prompts about pushing/forking
GH_PROMPT_DISABLED=1 gh pr create --draft --head <branch> --base <defaultBranch> --title "<t>" --body-file - < body.md
```
- Flags: `-d/--draft`, `-H/--head`, `-B/--base`, `-t/--title`, `-b/--body` or `-F/--body-file file|-`, `-f/--fill`
  (commit info for title+body), `--fill-first`, `--fill-verbose`, `--dry-run`. Supplying title+body (or `--fill`) avoids
  prompts; `GH_PROMPT_DISABLED=1` makes any remaining prompt an error instead of a hang.
- PR URL: "Upon success, the URL of the created pull request will be printed" to stdout → last non-empty stdout line.
- PR already exists → gh errors (`a pull request for branch … already exists`, message UNVERIFIED); check first with
  `gh pr view <branch> --json url,state -q .url` (exit non-zero if none) or `gh pr list --head <branch> --json url`.
- "Repo has a GitHub remote": `git remote get-url origin` matches `github.com[:/]` (cheap, offline); optionally
  `gh repo view --json url -q .url` (network + auth) and `gh auth status` (exit 0 when logged in). Run all with `cwd` = worktree.
- Behind `PrProvider { open({cwd, branch, base, title, body}): Promise<{url}> }`; the gate uses a fake.

## 7. Daemon WebSocket client (Node 24 global `WebSocket` = undici)

- Custom headers work: `new WebSocket(url, { headers: { authorization: 'Bearer …' } })` — undici `WebSocketInit`
  `{ protocols?, dispatcher?, headers? }`. Already used + verified live by `apps/cli/src/commands/watch.ts` (it casts
  `init as unknown as string[]` because the DOM `lib` typing only allows protocols). No Origin header is sent, so the
  api's CSWSH guard requires Bearer (or loopback dev bypass) — fine for the daemon.
- No built-in reconnect. Implement: exponential backoff with jitter (0.5 s → 30 s cap), reset after a stable 10 s
  open; on reconnect send/resume with `?since=<lastSeq>` (RunLog already replays); heartbeat `ping` every 25 s and treat
  no `pong` within 10 s as dead (`ws.close()` then reconnect) — with `setWebSocketAutoResponse` this doesn't wake the DO.
- Buffer outgoing agent events in memory (and optionally the HTTP batch fallback) while disconnected; give each event a
  daemon-side `clientSeq` / idempotency key so a resend after reconnect can be deduped by the DO.
- `ws.send` before `open` throws `InvalidStateError`; check `ws.readyState === WebSocket.OPEN`. `bufferedAmount` for backpressure.

## 8. Latency "local agent event → GUI" p95 (stage 12)

Same harness as stages 4/5: `playwright-core` installed in a scratch/dev dir, `chromium.launch({ executablePath: '/usr/bin/chromium' })`
(the Playwright MCP needs /opt/google/chrome, which is absent). Plan:
1. The `fake` adapter emits N (e.g. 200) `message` events at ~20 ms intervals, each carrying `emittedAt = Date.now()`
   (performance.timeOrigin + performance.now() for sub-ms) set in the daemon right before `ws.send`.
2. Web run page renders each event with `data-seq` and `data-emitted-at`. In the page, before the run starts:
   ```js
   await page.evaluate(() => { window.__lat = []; new MutationObserver((ms) => { const t = performance.timeOrigin + performance.now();
     for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) for (const el of [n, ...n.querySelectorAll('[data-emitted-at]')])
       if (el.dataset?.emittedAt) window.__lat.push(t - Number(el.dataset.emittedAt)); }).observe(document.body, { childList: true, subtree: true }); });
   ```
   (Optionally wait a `requestAnimationFrame` before stamping to measure paint, not DOM insertion.)
3. Collect `window.__lat`, compute p50/p95 (sort, index `ceil(0.95*n)-1`), write to `perf-budget.json` as
   `{ "agentEventToGui": { "p95Ms": x, "budgetMs": 250, "measured": true } }`, fail the gate if over budget.
Same machine → one clock, no skew. Measures daemon → api (DO append) → broadcast → browser WS → React render. Run
against `pnpm dev` (5173) with the daemon pointed at 5173 too (one process for DO sockets, stage 4 caveat).
Exclude the first ~10 events (warm-up / initial replay).

## Blockers / open risks
- None blocking: both SDKs reuse the existing subscription logins (Claude Max; ChatGPT for Codex) — no API keys.
- ~700 MB of optional platform binaries per install unless the build stages decide to rely on local CLIs only
  (pnpm cannot easily skip specific optional deps; `pathToClaudeCodeExecutable`/`codexPathOverride` still need the
  package installed for types). Accept for now.
- Claude per-turn `result` and `total_cost_usd` cumulative semantics, and `priority` on follow-ups: confirm in the
  stage-9 manual smoke run.
