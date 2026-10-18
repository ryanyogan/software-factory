# Phase 2 research: brain, registry, MCP, deploy (stage 13, 2026-10-17)

Sources: installed `.d.ts`/dist in the repo and in scratch installs under
`/tmp/claude-1000/-home-ryan-code/0c079673-aae3-4fb1-8cad-edde17f0f53e/scratchpad/p2/`, Context7 (Cloudflare docs,
`/cloudflare/agents`), the bundled codex 0.163.0 binary run against a throwaway `CODEX_HOME`, and read-only `wrangler whoami`
plus a GET of the account's workers.dev subdomain. Nothing was deployed or created. **UNVERIFIED** means read from docs or
source but not run.

## 0. Summary of recommendations

| Question | Pick | Why |
|---|---|---|
| MCP server | `createMcpHandler` from `agents/mcp/server` (stateless, **no DO**) + SDK v2 `@modelcontextprotocol/server`, **mounted in sf-api at `/mcp`** | `McpAgent` is `@deprecated` and feature-frozen in agents 0.28.1. Mounting in sf-api calls `runCommand` directly (one path), and dev needs only a web proxy route. |
| MCP auth | Existing Better Auth **bearer session token** (`sf login` device flow), with a 401 + `WWW-Authenticate: Bearer` precheck | No new tables, KV or consent UI. Real OAuth (`@better-auth/mcp`) can come later for claude.ai/Desktop connectors. |
| Retrieval | **Vectorize (namespace per project) + Workers AI `@cf/qwen/qwen3-embedding-0.6b` + D1 FTS5, fused with RRF**, behind `BrainPort` | We chunk by symbol and need deterministic delete/re-index. AI Search re-chunks, is remote-only even in dev, and costs $0.75 per 1k hybrid queries. |
| Indexing | GitHub webhook → Queue → Workflow (`step.do` per file batch) in sf-api | Both run in Miniflare; the vite `auxiliaryWorkers` setup needs no change. |
| GitHub | **Org webhook (shared secret) + a fine-grained PAT secret** (contents:read, pull_requests:read) | Simplest for one org. A GitHub App comes later (needs JWT RS256 + installation tokens). |
| Skills sync | Canonical `.agents/skills/<n>/` + per-skill symlink `.claude/skills/<n> -> ../../.agents/skills/<n>`, sync **into each worktree** before the agent starts | Codex reads `.agents/skills` and not `.claude/skills`. Claude reads `.claude/skills` (symlinks are fine). |
| Model calls | `env.AI.run(model, input, { gateway: { id: 'sf', metadata: { org, project, run, op } } })` | Max 5 metadata keys. Vectorize never goes through the gateway. |

**Changes to the Phase 2 decisions** (see the end of HANDOFF.md):
- #5: "McpAgent" becomes the stateless `createMcpHandler` in sf-api.
- #7: "per-project AI Search instance" becomes a Vectorize namespace per project + D1 FTS5.

---

## 1. Remote MCP on Workers

### Versions (npm latest, 2026-10-17)
`agents@0.28.1`, `@modelcontextprotocol/server@2.3.1` (SDK v2), `@modelcontextprotocol/sdk@1.32.1` (v1, client side),
`@cloudflare/workers-oauth-provider@1.2.3`, `@better-auth/oauth-provider@1.7.10`, `@better-auth/mcp@1.7.10`.
`agents` pins `@modelcontextprotocol/{server,client}@2.3.1` and `sdk@1.32.1` as **optional exact peers** and wants
`zod ^4.0.0`. Install `@modelcontextprotocol/server@2.3.1` explicitly.

### `McpAgent` is deprecated
In `agents/dist/agent-routing-*.d.ts`:
> `@deprecated McpAgent is feature-frozen. Migrate to an SDK v2 factory with createMcpHandler from agents/mcp/server.`

For the record, McpAgent works like this:
- Shape: `abstract class McpAgent<Env, State, Props> extends Agent`, with `server` (v1 `McpServer`), `init()` and `this.props`.
- `McpAgent.serve(path, { binding = 'MCP_OBJECT', transport: 'streamable-http'|'sse'|'rpc'|'auto', corsOptions, jurisdiction })`.
- It needs a DO binding plus a `new_sqlite_classes` migration.

Don't use it, and don't use `createLegacyMcpHandler` / `experimental_createMcpHandler` either.

### Stateless handler (use this)
```ts
// agents/mcp/server  (agents@0.28.1)
export { createStatelessMcpHandler as createMcpHandler, getMcpAuthContext, type McpAuthContext /* { props } */ }
declare function createMcpHandler(factory: McpServerFactory, options?: CreateStatelessMcpHandlerOptions): StatelessMcpHandler;
type McpServerFactory = (ctx: { era: 'legacy'|'modern'; authInfo?: AuthInfo; requestInfo?: Request }) => McpServer | Promise<McpServer>;
interface CreateStatelessMcpHandlerOptions {
  route?: string;                 // exact pathname, default "/mcp"
  corsOptions?: {...} | false;
  allowedHostnames?: string[];    // Host check; localhost + *.workers.dev allowed by default
  allowedOriginHostnames?: string[] | '*';
  legacy?: 'stateless' | 'reject';// default 'stateless' (still serves 2025-era clients; GET/DELETE → 405)
  responseMode?: 'auto'|'sse'|'json'; keepAliveMs?: number; maxRequestBodySize?: number; onerror?: ...;
}
type StatelessMcpHandler = {
  (request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;   // reads ctx.props
  fetch(request: Request, options?: { authInfo?: AuthInfo; parsedBody?: unknown }): Promise<Response>;
};
```
- The transport is Streamable HTTP, and a new server is built per request.
- It imports `node:async_hooks`, so `nodejs_compat` is required (already set).
- **Gotcha:** custom domains need `allowedHostnames` set. Defaults cover only localhost and `*.workers.dev`.

### Tools from zod 4 (verified with `tsc --strict`)
SDK v2 `registerTool` accepts any **Standard Schema with JSON**, and zod 4 classic schemas implement it. A value typed as
`z.ZodType` (our `CommandDef.input`) typechecks. Don't pass a `ZodRawShape`; that overload is deprecated. Don't use
`zod-to-json-schema`.
```ts
registerTool(name, { title?, description?, inputSchema?: StandardSchemaWithJSON, outputSchema?, annotations? },
  (args, ctx: ServerContext) => CallToolResult | Promise<CallToolResult>)   // ctx.http?.authInfo available
```
```ts
// apps/mcp/src/server.ts — pure factory over the contract; sf-api imports it
import { McpServer } from '@modelcontextprotocol/server';
import { commands } from '@sf/contract';
export type Call = (name: string, input: unknown) => Promise<CommandResult>;
export const toolName = (command: string) => command.replace(/[^a-zA-Z0-9_-]/g, '_'); // run.start → run_start
export function buildServer(call: Call) {
  const server = new McpServer({ name: 'software-factory', version: '0.1.0' });
  for (const def of Object.values(commands)) {
    server.registerTool(toolName(def.name), { description: def.summary, inputSchema: def.input }, async (args) => {
      const r = await call(def.name, args);
      return r.ok
        ? { content: [{ type: 'text', text: JSON.stringify(r.data) }] }
        : { isError: true, content: [{ type: 'text', text: `${r.error.code}: ${r.error.message}` }] };
    });
  }
  return server;
}
```
- Map `.` to `_` in tool names. Claude normalizes names anyway (see §7), and some clients reject `.`.
- Leave `outputSchema` off for now. It requires object `structuredContent`.
- Add an allowlist, so dangerous or internal commands (`run.append`?) aren't exposed. Decide this in stage 16.

### Auth options
- **`@cloudflare/workers-oauth-provider@1.2.3`**
  - Usage: `new OAuthProvider({ apiRoute, apiHandler, defaultHandler, authorizeEndpoint, tokenEndpoint, clientRegistrationEndpoint?, resourceMetadata /* REQUIRED in 1.x */, resolveExternalToken?, accessTokenTTL, ... })`.
  - It needs KV `OAUTH_KV`. Props arrive on `ctx.props` and are read with `getMcpAuthContext().props`.
  - **Gotcha (source-read):** it calls `apiHandler.fetch(req, env, ctx)`, so wrap the stateless handler as `{ fetch: (r, e, c) => handler(r, e, c) }`.
- **Better Auth 1.7.10**
  - `better-auth/plugins` has **no `mcp()` and no `oidcProvider()`**. They moved to `@better-auth/mcp` and `@better-auth/oauth-provider`.
  - `@better-auth/mcp` exports:
    - `mcp({ resource, loginPage, consentPage, ... })`. It *is* the OAuth 2.1 provider, and it needs `jwt()`.
    - `requireMcpAuth(auth, handler)`.
    - `createMcpProtectedRequestHandler({ issuer, audience, jwksUrl })`.
  - It adds tables `oauthClient`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `oauthClientResource`, `oauthResource`, `oauthClientAssertion` and `jwks`. Generate them with `pnpm --filter @sf/api auth:schema`, then `db:generate`.
  - `withMcpAuth` / `getMcpSession` are gone.
- **Pick for Phase 2: bearer session token.** The daemon already holds the user's token from `sf login` and injects it into the agent's MCP config. `runCommand(env, name, input, { headers })` already resolves `Authorization: Bearer` with `auth.api.getSession`. Defer OAuth until someone wants claude.ai or Desktop connectors.
  - **Risk:** the full user session token lands in agent configs. The Claude SDK passes `--mcp-config <json>` on argv, so the token is visible in `ps`.
  - **Follow-up (optional in 16):** a per-run scoped token (`run.token` command → short-TTL row, checked in `resolveUserId`).

### Topology: mount in sf-api (recommended)
```ts
// apps/api/src/app.ts (Hono)
import { createMcpHandler } from 'agents/mcp/server';
import { buildServer } from '@sf/mcp';
app.all('/mcp', async (c) => {
  const auth = c.req.header('authorization');
  const origin = new URL(c.req.url).origin;
  const headers = new Headers(auth ? { authorization: auth } : {});
  if (!(await resolveUserId(c.env, { headers, origin })))
    return c.json({ error: { code: 'unauthorized' } }, 401, { 'www-authenticate': 'Bearer' });
  const handler = createMcpHandler(() => buildServer((n, i) => runCommand(c.env, n, i, { headers, origin })), { route: '/mcp' });
  return handler.fetch(c.req.raw);
});
```
```ts
// apps/web/src/routes/mcp.ts — copy of routes/v1/$.ts so http://localhost:5173/mcp works in dev; no vite change
export const Route = createFileRoute('/mcp')({ server: { handlers: { ANY: ({ request }) => env.API.fetch(request) } } });
```
- **Why not a separate `sf-mcp` Worker:** auxiliary workers are reachable only through bindings, so a separate Worker needs a third `auxiliaryWorkers` entry, a new `MCP` binding plus proxy route in web, and another deploy step. It also gains nothing while there's no DO.
  - A split is still possible later with the same `buildServer`, using `services: [{ binding: 'API', service: 'sf-api', entrypoint: 'ApiRpc' }]` and `env.API.command(n, i, { sessionToken, origin })`. `RpcAuth` and `CommandResult` are plain data, so the RPC hop is fine.
- **Cost:** adding `agents` and `@modelcontextprotocol/server` to sf-api. Keep `apps/mcp` as the `@sf/mcp` package with `buildServer`, using TS source exports like the other packages.
- **Dev bypass:** `SF_DEV_AUTH` + a loopback origin carries over, because `origin` is passed through.

---

## 2. Retrieval: AI Search vs Vectorize + FTS5

### Cloudflare AI Search (formerly AutoRAG)
- **Status:** GA on 2026-10-01. **Billing starts 2026-11-01.** `env.AI.autorag()` and `env.AI.aiSearch()` are `@deprecated` in workers-types 5.20261016.1.
- **Bindings (schema-verified):**
  ```jsonc
  "ai_search_namespaces": [{ "binding": "AI_SEARCH", "namespace": "sf-brain", "remote": true }], // runtime instance CRUD
  "ai_search": [{ "binding": "DOCS_SEARCH", "instance_name": "x", "remote": true }]                 // single instance
  ```
  The namespace has to be created first: `wrangler ai-search namespace create sf-brain`.
- **Namespace API:** `get(name)`, `list()`, `create(config)`, `delete(name)`, `search({ ai_search_options: { instance_ids } })` (1–10 instances), `chatCompletions`. Per-project instances at runtime are supported, and the docs recommend one instance per tenant. Instance id: 1–32 chars, `^[a-z0-9_]+(?:-[a-z0-9_]+)*$`.
- **Instance API:**
  - `search`, `chatCompletions`, `update`, `info`, `stats`
  - `items.upload(name, content, { metadata })` (upsert by filename), `items.uploadAndPoll(...)`, `items.list/get/delete`
  - `jobs.*`
  - Built-in storage indexes uploads immediately. R2 and web sources sync on an interval of ≥ 1 h, or on `jobs.create()`.
- **Search request:**
  ```ts
  await env.AI_SEARCH.get(`p-${projectId}`).search({ query, ai_search_options: { retrieval: {
    retrieval_type: 'hybrid', fusion_method: 'rrf', max_num_results: 10 /*1–50*/, match_threshold: 0.4,
    filters: { folder: { $gte: 'src/', $lt: 'src0' } } }, reranking: { enabled: false } } });
  // → { search_query, chunks: [{ id, score, text, item: { key, timestamp?, metadata? }, scoring_details? }] }
  ```
- **Hybrid search:** set per instance with `index_method: { vector: true, keyword: true }`, and `keyword_tokenizer: 'porter'|'trigram'`.
- **Filters:** `filename`, `folder`, `timestamp`, plus **5 custom metadata fields per instance**.
- **Limits:** 5,000 instances per account; 1M files per instance (500k with hybrid); 10 MiB text files; key ≤ 128 chars.
- **Pricing:**
  - Ingestion: 5M tokens free, then $0.75 per M.
  - Storage: 10 GB free, then $2 per GB.
  - **Hybrid/vector queries: 1k free, then $0.75 per 1k.**
  - Keyword queries: $0.10 per 1k.
- **Local dev: none.** Wrangler marks it "never local", so it always proxies to the real, billed account. **UNVERIFIED:** what `chunk: false` does in `AiSearchConfig`, and whether it would keep our symbol chunks intact.
- **Single instance + folder/`projectId` filter (Alternative A):** isolation depends on every query adding the filter, and all projects share the file cap. The docs prefer one instance per tenant. Not worth it.

### Pick: Vectorize + Workers AI embeddings + D1 FTS5 (RRF)
**wrangler.jsonc additions (api):**
```jsonc
"ai": { "binding": "AI", "remote": true },                       // never local; always billed even in dev
"vectorize": [{ "binding": "BRAIN_VEC", "index_name": "sf-brain", "remote": true }],
```
**One-time setup** (stage 17, not now). Metadata indexes must exist before the first upsert.
```sh
pnpm exec wrangler vectorize create sf-brain --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index sf-brain --propertyName=path --type=string
pnpm exec wrangler vectorize create-metadata-index sf-brain --propertyName=kind --type=string
pnpm exec wrangler vectorize create sf-brain-dev --dimensions=1024 --metric=cosine   # what dev's remote binding points at
```
**Vectorize v2 signatures:**
- `upsert(VectorizeVector[])` → `{ mutationId }` (async; poll `describe().processedUpToMutation`)
- `query(vec, { topK, namespace, returnMetadata: 'indexed'|'all'|'none', filter })` → `{ matches: [{ id, score, metadata }] }`
- `deleteByIds(ids)`, `getByIds`, `describe()`
- `VectorizeVector = { id ≤64B, values, namespace?, metadata? }`
- Filter operators: `$eq $ne $lt $lte $gt $gte $in $nin`.

**Vectorize limits:**
- 50k namespaces per index (namespace = projectId)
- topK ≤ 100 (≤ 50 with metadata `all`)
- 1536 dims maximum
- 10 metadata indexes; 10 KiB metadata
- Upsert batch of 1,000
- **No delete-by-filter or delete-by-namespace.** Keep chunk ids in D1.

**Embeddings:** `@cf/qwen/qwen3-embedding-0.6b`: 1024 dims, long input (4k–8k tokens; sources disagree), $0.012 per M tokens. It is also the AI Search default.
- Input `{ queries?, documents?, text?, instruction? }`, output `{ data: number[][] }`.
- **UNVERIFIED:** the query/document asymmetry. Test with `documents` for chunks and `queries` for queries.
- Fallback: `@cf/baai/bge-m3`, 1024 dims, but only 512 tokens.

**D1 FTS5:** supported.
- **Gotcha:** `wrangler d1 export` refuses databases that contain virtual tables. To export, drop the table, export, then recreate it.
- Drizzle can't model virtual tables. Use a custom migration (`pnpm --filter @sf/db db:generate --custom --name brain_fts`; from memory, check it) and raw `sql`.
```sql
CREATE VIRTUAL TABLE brain_fts USING fts5(chunk_id UNINDEXED, project_id UNINDEXED, path, symbol, body,
  tokenize = "unicode61 tokenchars '_'");
-- SELECT chunk_id, bm25(brain_fts) s FROM brain_fts WHERE brain_fts MATCH ?1 AND project_id = ?2 ORDER BY s LIMIT 50;
```
- FTS5 `MATCH` syntax breaks on raw user input such as `-`, `:` or quotes. Quote each term: `"term1" "term2"`.

**Normal D1 tables:**
- `brain_chunk(id PK, project_id, path, symbol, kind, start_line, end_line, content_hash, body, indexed_at)`
- `brain_file(project_id, path, sha, PK(project_id, path))`

**Chunk id:** `base64url(sha256(projectId|path|symbol|contentHash))`, 43 chars.

**Re-indexing a file:**
1. Chunk the file.
2. Diff the new chunk ids against the old ones in D1.
3. Delete removed ids from Vectorize (`deleteByIds`) and D1.
4. Embed and upsert only the new ids.
5. Write the FTS and chunk rows in one `db.batch`.

**Fusion sketch:**
```ts
const [qv] = (await env.AI.run('@cf/qwen/qwen3-embedding-0.6b', { queries: [q] },
  { gateway: { id: 'sf', metadata: { org, project: projectId, op: 'embed-query' } } })).data!;
const v = await env.BRAIN_VEC.query(qv, { topK: 50, namespace: projectId, returnMetadata: 'indexed' });
const k = await ftsSearch(db, projectId, q, 50);
const score = new Map<string, number>();
for (const list of [v.matches.map((m) => m.id), k.map((r) => r.chunk_id)])
  list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (61 + i)));
// top N ids → hydrate from brain_chunk → { path, symbol, lines, snippet, score, source: 'project' }
```
**`BrainPort` (packages/brain):** `upsertFile(projectId, path, sha, chunks[])`, `deleteFile(projectId, path)`, `search(projectId, q, { k, kinds? })`.
- Prod adapter: `cloudflareBrain(env)`.
- Test and gate adapter: `memoryBrain()` (substring BM25-ish scoring + fake hash vectors + RRF).

**Org standards and skills from the registry:**
- Index them into namespace `org-<orgId>`, or a reserved `_org` namespace.
- `brain.context_for_task` queries the project namespace and the org namespace and merges the results.

**Why this over AI Search:**
- We control the chunk boundaries.
- Deletes are exact.
- FTS runs locally in Miniflare, and only the embedding and Vectorize calls are remote.
- The cost is cents per month.
- The port keeps AI Search possible later, e.g. for PDF and website docs.

---

## 3. Workflows + Queues

**Config (api wrangler.jsonc):**
```jsonc
"queues": {
  "producers": [{ "binding": "INDEX_QUEUE", "queue": "sf-index" }],
  "consumers": [{ "queue": "sf-index", "max_batch_size": 10, "max_batch_timeout": 5, "max_retries": 3,
                  "dead_letter_queue": "sf-index-dlq" }]
},
"workflows": [{ "name": "sf-index-repo", "binding": "INDEX_WORKFLOW", "class_name": "IndexRepoWorkflow" }]
```
Create the queues with `pnpm exec wrangler queues create sf-index` and `... sf-index-dlq` (a DLQ is auto-created on deploy if missing). Workflows need no create step: deploy registers them.

**Workflow class** (`cloudflare:workers`; types from the generated `worker-configuration.d.ts`):
```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
type IndexParams = { projectId: string; repo: string; before: string | null; after: string; deliveryId: string };
export class IndexRepoWorkflow extends WorkflowEntrypoint<Env, IndexParams> {
  async run(event: WorkflowEvent<IndexParams>, step: WorkflowStep) {
    const files = await step.do('list changed files', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
      () => listChanged(this.env, event.payload));        // ≤ 1 MiB return value per step; return paths, not contents
    for (const [i, batch] of chunked(files, 20).entries())
      await step.do(`index batch ${i}`, { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } },
        () => indexBatch(this.env, event.payload, batch)); // fetch → chunk → embed → upsert; idempotent by chunk id
    await step.do('mark indexed', () => markIndexed(this.env, event.payload));
  }
}
export { IndexRepoWorkflow } from './brain/index-workflow'; // must be exported from apps/api/src/index.ts
```
- `WorkflowStepConfig = { retries?: { limit, delay, backoff?: 'constant'|'linear'|'exponential' }, timeout?, sensitive?: 'output' }`.
- **Steps must be deterministic and idempotent.** Names must be stable. No non-step side effects inside `run`.
- Step limits: default 10k steps per instance, raisable with `limits.steps`; ≤ 1 MiB per step return value.

**Queue consumer → Workflow** (same Worker; add `queue` to the default export next to `fetch`):
```ts
async queue(batch: MessageBatch<IndexParams>, env: Env) {
  const r = await env.INDEX_WORKFLOW.createBatch({ instances: batch.messages.map((m) => ({ id: `idx-${m.body.deliveryId}`, params: m.body })) });
  batch.ackAll(); // createBatch skips existing ids (idempotent) → redelivered GitHub hooks are no-ops
}
```
- `create({ id, params })` **throws** if the id exists. `createBatch` takes ≤ 100 instances and skips duplicates; the object form returns `{ ...errors }` per instance (types in the generated d.ts).
- Instance ids must be unique for the retention period, so use the GitHub delivery id, or `${projectId}-${after}`.

**Why the queue at all:** the webhook must answer GitHub within 10 s, so it verifies, `INDEX_QUEUE.send(...)`, and returns 202. The queue also absorbs bursts and gives the DLQ. Calling `INDEX_WORKFLOW.create` straight from the webhook would also work and is simpler. Keep the queue anyway, because the plan wants it and it rate-limits creates.

**Local dev:** Miniflare (5.20261012) implements both Queues and Workflows. The vite plugin passes them through for auxiliary workers, since it reads the api's `wrangler.jsonc` exactly as it does for D1/DOs today, and state lands under `persistState` (`SF_STATE_DIR`). **UNVERIFIED at runtime.** Stage 17 should smoke it first: POST a signed fake webhook to `localhost:5173/v1/github/webhook`, then watch the workflow run. Also `pnpm exec wrangler workflows instances list sf-index-repo --local` (UNVERIFIED flag). The `AI` and `BRAIN_VEC` bindings are remote even in dev, so local indexing **spends real (tiny) embedding money**. The gate must use `memoryBrain`, e.g. an env flag `SF_BRAIN=memory` read by the api.

**Tests:** `@cloudflare/vitest-plugin` 1.4.4 is in apps/api. Unit-test `indexBatch`/`listChanged` as plain functions with a fake `GitHubPort` + `memoryBrain`, rather than driving Workflows inside vitest.

---

## 4. AI Gateway

`GatewayOptions` (workers-types, verified):
```ts
{ id: string; cacheKey?; cacheTtl?; skipCache?; metadata?: Record<string, number|string|boolean|null|bigint>;
  collectLog?; eventId?; requestTimeoutMs?; retries?: { maxAttempts?: 1..5; retryDelayMs?; backoff? } }
```
```ts
await env.AI.run('@cf/qwen/qwen3-embedding-0.6b', { documents: texts },
  { gateway: { id: 'sf', skipCache: true, metadata: { org: orgId, project: projectId, op: 'embed-index' } } });
const logId = env.AI.aiGatewayLogId;                 // string | null, after a run
const log = await env.AI.gateway('sf').getLog(logId!); // { cost, tokens_in, tokens_out, metadata, cached, ... }
```
- **Binding vs URL:** use the binding option above for Workers AI. `env.AI.gateway(id).getUrl(provider)` gives the URL for third-party providers (OpenAI/Anthropic) if we ever call them from a Worker.
- **Metadata:** max **5 keys**, extra keys are silently dropped, and `cf.` keys are reserved. Use `{ org, project, run, op }`. Over HTTP the equivalent is the `cf-aig-metadata` header.
- **Creating the gateway:** `id: 'default'` auto-creates. A named gateway `sf` should be created once in the dashboard (UNVERIFIED: whether named ids auto-create too). Gateway logs give cost per metadata. Applies to embeddings too; UNVERIFIED that embedding cost is logged.
- **Not covered:** Vectorize never goes through the gateway, and AI Search's internal embeddings don't either. Account for those ourselves, e.g. count chunks and queries in D1 per project.

---

## 5. GitHub: webhook + file fetch

**Phase 2 pick: one org-level webhook + a fine-grained PAT.**
- The user creates them once in GitHub.
- Secrets on sf-api:
  - `GITHUB_WEBHOOK_SECRET`
  - `GITHUB_TOKEN`: fine-grained, org-owned, repo access = all or selected; Contents: read, Pull requests: read, Metadata: read.
- **Why not the users' OAuth tokens:** the Better Auth GitHub provider only requests `read:user user:email`. It can't read private repos, and indexing shouldn't depend on any one user's session.
- **Why not a GitHub App yet:** best long-term (per-installation tokens, no personal PAT), but it needs RS256 JWT signing. Web Crypto `RSASSA-PKCS1-v1_5` needs PKCS#8, so you'd run `openssl pkcs8 -topk8 -nocrypt` on GitHub's PKCS#1 key, plus an installation-token exchange. It's a good stage-19+ swap behind `GitHubPort`.
- **Webhook settings:**
  - Payload URL: `https://sf-web.ryanyogan.workers.dev/v1/github/webhook`, which goes through the existing web `/v1/*` proxy, so sf-api can stay private.
  - Content type: `application/json`.
  - Secret: the value of `GITHUB_WEBHOOK_SECRET`.
  - Events: **Pushes, Pull requests, Pull request review comments.**

**Signature check (Web Crypto, constant-time):**
```ts
export async function verifyGitHub(secret: string, body: ArrayBuffer, header: string | null): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  const given = hexToBytes(header.slice(7));
  return given.length === mac.length && crypto.subtle.timingSafeEqual(mac, given); // workerd extension on SubtleCrypto
}
// read the body ONCE as arrayBuffer (verify the raw bytes), then JSON.parse(new TextDecoder().decode(buf))
```

**Headers:** `X-GitHub-Event`, `X-GitHub-Delivery` (use it as the idempotency id), `X-Hub-Signature-256`. Answer `ping` with 204.

**Events to handle:**

| Event | Condition | Action |
|---|---|---|
| `push` | `ref === 'refs/heads/' + repository.default_branch`; ignore `deleted: true` | Enqueue `{ before, after }` |
| `pull_request` | `action === 'closed' && pull_request.merged === true` | Enqueue merged-PR review comments |
| `pull_request_review_comment` | `action === 'created'` | Optionally store now, and index at merge |

- If `before` is all zeros, the branch is new: do a full index.
- Map `repository.html_url`/`full_name` to a project via the project's `repoUrl`, normalizing `.git` and case.

**Fetching contents (REST, `Authorization: Bearer $GITHUB_TOKEN`, `User-Agent: sf`, `X-GitHub-Api-Version: 2022-11-28`):**
- **Incremental:** `GET /repos/{o}/{r}/compare/{before}...{after}` returns `files[]` with `filename`, `status` (added/modified/removed/renamed) and `previous_filename`, capped at 300 files. If the cap is hit, or `before` is all zeros, fall back to the full index. The push payload's `commits[].added/modified/removed` covers only 20 commits, so don't rely on it.
- **Single file:** `GET /repos/{o}/{r}/contents/{path}?ref={sha}` with `Accept: application/vnd.github.raw+json` returns raw bytes (up to 100 MB; skip anything over ~1 MB or binary). Alternative: `GET /repos/{o}/{r}/git/blobs/{sha}`.
- **Full index:** `GET /repos/{o}/{r}/tarball/{ref}` redirects (302) to codeload. Then `response.body.pipeThrough(new DecompressionStream('gzip'))` + a ~50-line ustar reader (512-byte headers; handle the `pax` `x` headers for long names). The first path segment is `{owner}-{repo}-{sha}/` and must be stripped.
  - Stream it. Don't buffer a big repo, given the 128 MB isolate.
  - Better: in a step, list paths with `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` (truncated above ~100k entries), then fetch blobs in batched steps. This fits Workflow steps (≤ 1 MiB returns) better than one giant tarball step. **Recommend the trees + blobs approach for Workflows.** The tarball is fine for a one-shot CLI-side index.
- **Merged PR review comments:** `GET /repos/{o}/{r}/pulls/{n}/comments?per_page=100` gives `body`, `path`, `line` and `diff_hunk`. Index them as `kind: 'review'` chunks keyed `pr/<n>/<comment id>`.
- **Rate limits:** a PAT gets 5,000 requests per hour, which is fine for one org. Use `If-None-Match` ETags if needed.

---

## 6. Agent Skills: format and locations (verified by running codex 0.163.0 `app-server skills/list`)

**SKILL.md** (agentskills.io spec):
- **Layout:** `<name>/SKILL.md` + optional `scripts/`, `references/`, `assets/`.
- **Required frontmatter:**
  - `name`: 1–64 chars `[a-z0-9-]`, no leading, trailing or double `-`, **must equal the directory name**.
  - `description`: 1–1024 chars; say what it does and when to use it.
- **Optional frontmatter:** `license`, `compatibility` (≤ 500 chars), `metadata` (string → string map), `allowed-tools` (space-separated, experimental).
- **Claude Code extras:** `when_to_use`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `model`, `context: fork`, `paths`, etc. `description` + `when_to_use` are capped at 1,536 chars in the listing.
- Keep the body under 500 lines.
- Codex is lenient: it loads bad names. **`sf` should validate the strict spec** when syncing the registry.
```md
---
name: sf-org-standards
description: Org coding standards for <org>. Use when writing or reviewing code in any org repo.
metadata:
  sf-managed: "true"
  sf-source: "registry@<sha>"
---
```

**Where they load:**
- **Claude Code** (bundled CLI 2.1.302):
  - Paths: `.claude/skills/<n>/SKILL.md` in the cwd and parents up to the repo/worktree root, `~/.claude/skills`, and `additionalDirectories/.claude/skills`. Per-skill symlinks are supported.
  - SDK: `settingSources` must include `'project'` (ours is `['project','local']`, so project skills load but `~/.claude/skills` doesn't).
  - Set `skills: 'all'` (sdk.d.ts) in `claudeOptions()`. Don't add `'Skill'` to `allowedTools` (deprecated).
  - `system/init.skills: string[]` shows what loaded, so the gate can assert on it.
  - Worktree fallback to the main checkout applies only if the worktree has no `.claude/skills`. This repo commits some, so the fallback is irrelevant here.
- **Codex 0.163.0:**
  - Repo scope: `<cwd and parents to git root>/.agents/skills/` and `<root>/.codex/skills/`. **It does not read `.claude/skills`.**
  - User scope: `$CODEX_HOME/skills`, `~/.agents/skills`.
  - Symlinks are followed.
  - On by default; no feature flag.

**`sf skills sync` design:**
1. Resolve skills (`skills.resolve` → registry `skills/` + org defaults + project overrides). Write each to the **canonical `.agents/skills/<n>/`**.
2. Create a relative per-skill symlink `.claude/skills/<n> -> ../../.agents/skills/<n>`. Never replace the whole `.claude/skills` directory, which holds hand-authored skills.
3. Ownership: an `sf-` name prefix + `metadata.sf-managed` + `.agents/skills/.sf-manifest.json`. Sync adds, updates and prunes only what it owns, and refuses to clobber foreign dirs.
4. **Worktrees:** the daemon runs the same sync into each task worktree before `startAgent`. Gitignored files don't exist in a new `git worktree add`.
5. Add the gitignore entries `/.agents/skills/sf-*/`, `/.claude/skills/sf-*` and `/.agents/skills/.sf-manifest.json`. The default is to not commit synced skills; offer `--commit` later.
6. The plan's "`.codex/`" target changes to `.agents/skills`. Codex also reads `.codex/skills`, but `.agents` is the open standard.

---

## 7. MCP injection into runs

**Claude Agent SDK 0.3.302** (`sdk.d.ts`):
```ts
type McpHttpServerConfig = { type: 'http'; url: string; headers?: Record<string,string>;
  tools?: { name: string; permission_policy?: 'always_allow'|'always_ask'|'always_deny' }[]; timeout?: number; alwaysLoad?: boolean };
// claudeOptions():
mcpServers: { sf: { type: 'http', url: `${apiUrl}/mcp`, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } },
allowedTools: ['mcp__sf__*'],
skills: 'all',
```
- **Tool names:** `mcp__<server>__<tool>`, with each part normalized by `s.replace(/[^a-zA-Z0-9_-]/g, '_')`. So `brain.search` becomes **`mcp__sf__brain_search`**.
- **`alwaysLoad: true`:** without it, tools are deferred behind ToolSearch and may not be callable on turn 1.
- **Permissions:** `acceptEdits` doesn't auto-approve MCP. Our `canUseTool` path guard allows calls with no `file_path`, and `allowedTools` makes it explicit.
- **Connection status:** `system/init.mcp_servers[{ name, status }]`; log a warning when `status !== 'connected'`.
- **Token exposure:** `mcpServers` goes to the CLI as `--mcp-config <json>` on **argv**, so the token is visible in `ps` (see the per-run token follow-up in §1).

**Codex SDK 0.163.0:**
- `new Codex({ config, configOverrides, env, codexPathOverride })`. `config` is flattened into `--config k=v` (TOML literals). With `env` set, `process.env` is not inherited.
- No feature flag. Keys were checked with `codex mcp get --json`.
- Unknown keys are silently accepted, but enum and boolean values are validated.
```ts
new Codex({ env: { ...env, SF_MCP_TOKEN: token }, codexPathOverride, config: { mcp_servers: { sf: {
  url: `${apiUrl}/mcp`, bearer_token_env_var: 'SF_MCP_TOKEN', default_tools_approval_mode: 'approve',
  startup_timeout_sec: 10, tool_timeout_sec: 60 } } } })
```
- Other keys: `http_headers`, `env_http_headers`, `enabled_tools`/`disabled_tools`, `required`.
- **Approval mode:** `'approve'` is the safe choice for `approvalPolicy: never`. UNVERIFIED: how `auto` behaves in that case.
- **Network:** UNVERIFIED whether the workspace-write sandbox with network off blocks MCP HTTP. Believed not, because MCP runs in the codex process.
- **Events:** `item.started`/`item.completed` with `item.type === 'mcp_tool_call'` and `{ server, tool, arguments, result?: { content, structured_content }, error?, status }`.
- **Fix in `packages/adapters/src/codex/map.ts`:** it currently names these `${server}.${tool}`. Normalize to ``mcp__${n(server)}__${n(tool)}``, so both adapters emit the same name (`mcp__sf__brain_search`). The adoption metric then reduces to `tool.call` names starting with `mcp__sf__brain_`.

**Fake adapter:**
- Today's `tool` step (`{ type:'tool', name:'mcp__sf__brain_search', input, output }`) fakes only the event.
- For the gate, add an `mcp` step that really calls the server:
```ts
z.object({ type: z.literal('mcp'), server: z.string().default('sf'), tool: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })
// runtime (lazy import; move @modelcontextprotocol/sdk@1.32.1 from devDependencies to dependencies of @sf/adapters):
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const client = new Client({ name: 'sf-fake', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } }));
emit({ type: 'tool.call', id, name: `mcp__${n(step.server)}__${n(step.tool)}`, input: step.arguments });
const r = await client.callTool({ name: n(step.tool), arguments: step.arguments });
emit({ type: 'tool.result', id, isError: !!r.isError, output: textOf(r.content) });
```
- Share `StartAgentOptions.mcp?: { name, url, token }` across all three adapters.
- Unit tests: `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js` + a v1 `McpServer` (`@modelcontextprotocol/sdk/server/mcp.js`).
- The v1 client talks to the v2 server fine, since it's the same wire protocol. UNVERIFIED at runtime: protocol-version negotiation, because `legacy: 'stateless'` serves 2025-era clients.
- **Dev-bypass note for gate:brain:** the gates authenticate through the `SF_DEV_AUTH` loopback bypass. The MCP precheck passes `origin`, so a loopback URL with no bearer also resolves to the dev user, and the fake adapter can send no token locally.

---

## 8. First deploy (stage 14)

**Account facts (read-only):**
- wrangler 4.151.1, logged in as ryanyogan@gmail.com, account `8ad084035b854467eb9d93ae3363d40b`.
- **workers.dev subdomain `ryanyogan`**, so the URLs will be:
  - web: **`https://sf-web.ryanyogan.workers.dev`**
  - api: `https://sf-api.ryanyogan.workers.dev`
- Existing scripts don't include `sf-api`/`sf-web`, so there are no name clashes. I didn't confirm that no D1 named `sf` exists (the full list was not read), so check `wrangler d1 list` before creating.
- The token has the `d1`, `workers_scripts`, `queues`, `ai`, `ai-search` (and more) write scopes. It is missing `k2.*`, which is irrelevant.

**The user must create a GitHub OAuth App** (Settings → Developer settings → OAuth Apps → New):
- Application name: `Software Factory`
- Homepage URL: `https://sf-web.ryanyogan.workers.dev`
- Authorization callback URL: **`https://sf-web.ryanyogan.workers.dev/api/auth/callback/github`**
- Leave "Enable Device Flow" off (sf's device flow is Better Auth's own).
- Generate a client secret.
- The local `.dev.vars` GitHub app, if any, stays separate (OAuth apps allow one callback URL).

**Commands, in order** (from the repo root unless noted):
```sh
pnpm install --frozen-lockfile && pnpm check && pnpm typecheck && pnpm test && pnpm build
cd apps/api
pnpm exec wrangler d1 list                       # make sure "sf" doesn't exist yet
pnpm exec wrangler d1 create sf                  # → paste database_id into apps/api/wrangler.jsonc
# edit apps/api/wrangler.jsonc vars:
#   "BETTER_AUTH_URL": "https://sf-web.ryanyogan.workers.dev",
#   "WEB_ORIGIN": "https://sf-web.ryanyogan.workers.dev"
#   (dev keeps working: .dev.vars overrides vars locally, and .dev.vars.example already has the localhost values)
pnpm exec wrangler d1 migrations apply DB --remote     # = pnpm --filter @sf/api db:migrate:remote
pnpm exec wrangler deploy                               # sf-api first (creates the script; DO migration v1 applies)
openssl rand -base64 48 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET     # each secret put creates a new version
cd ../web && pnpm run deploy                            # vp build && wrangler deploy (sf-web)
cd ../.. && SF_API_URL=https://sf-web.ryanyogan.workers.dev pnpm sf login
```
- **Gotcha:** `.dev.vars` overrides `vars` in `wrangler dev` and in the vite plugin, so changing `vars` to prod values is safe only if `.dev.vars` sets both. Checked: the user's `apps/api/.dev.vars` defines `BETTER_AUTH_URL` and `WEB_ORIGIN`. Alternative: keep localhost in `vars` and put the prod values in an `env.production` block deployed with `--env production`. But env blocks rename the worker to `sf-api-production`, which breaks the web service binding name, so **use `.dev.vars`**.

**How the service binding resolves in prod:** `services: [{ binding: 'API', service: 'sf-api', entrypoint: 'ApiRpc' }]` binds by **script name in the same account** to the named export. sf-api must be deployed first, or web's deploy fails or warns about the missing service. `wrangler deploy` in apps/web uses the vite-built `dist/server/wrangler.json` (redirected config). The `auxiliaryWorkers` entry only affects dev and build; the api is not deployed by the web deploy.

**Better Auth over https (verified in `better-auth/dist/cookies/index.mjs`):**
- `baseURL` starting with `https://` sets the cookie prefix `__Secure-`, `secure: true`, `sameSite: 'lax'`, `httpOnly`, `path: '/'`. No config is needed.
- Cookies live on the web origin, because web proxies `/api/auth/*`.
- `trustedOrigins = WEB_ORIGIN`.
- The CLI uses the bearer, so it's unaffected.

**Things that break or matter in prod:**
1. **CLI ignores the saved `apiUrl`.** `sf login` writes `config.apiUrl`, but `resolveApiUrl()` (apps/cli/src/config.ts:73) is only `--api > SF_API_URL > localhost`. `client.ts`, `daemon.ts`, `watch.ts` and `open.ts` call it without `config.apiUrl`; only `auth.ts` logout/whoami pass it. After a prod login, `sf task list` and `sf daemon` would hit localhost with the prod token. **Fix in stage 14:** `--api > SF_API_URL > config.apiUrl > default`, and test it.
2. **sf-api is public on `sf-api.ryanyogan.workers.dev`.** Everything (browser, CLI, webhook, MCP) can go through the web proxies (`/v1/*`, `/api/auth/*`, later `/mcp`), so set `"workers_dev": false, "preview_urls": false` in apps/api/wrangler.jsonc. Service bindings still work. This shrinks the attack surface: the WS origin guard, CORS-less REST and the dev-bypass code path are all reachable only via web.
3. **Dev bypass is safe in prod.** `SF_DEV_AUTH` is only in `.dev.vars` (not uploaded), and every bypass is also loopback-gated (`devAuthAllowed`, `devSignIn`, web `getViewer`, `agentsFor`, `/device` button). **Never `wrangler secret put SF_DEV_AUTH`.** Optional hardening: assert `env.SF_DEV_AUTH !== '1'` when `BETTER_AUTH_URL` is https.
4. **`persistState` / `SF_STATE_DIR`** only affect dev, not deploy.
5. **`DEFAULT_WEB_ORIGINS`** are used only when `WEB_ORIGIN` is empty. Prod sets it, so localhost is not trusted in prod.
6. **`auth-client.ts` SSR `baseURL: 'http://localhost'`** is only used server-side for the client object. It's harmless unless an SSR path calls `authClient` (none found), but worth a comment.
7. **D1 placeholder id:** the vite plugin and `--local` don't care about the real id, so committing it is fine (not a secret).
8. **CI deploy job** is commented out and stays so; Actions budget is blocked. Deploy by hand.
9. ~~`ci.yml` / `gate-local.mjs` had uncommitted edits~~ — resolved: the orchestrator committed them (5dd5d74, CI failure evidence) while research ran.

**Prod smoke (stage 14):**
- `curl -s https://sf-web.ryanyogan.workers.dev/api/auth/get-session` → `null`/200
- GitHub sign-in in a browser
- `sf login` → `/device` approve → `sf project create` → `sf task create` → `sf run start --agent fake` with a local `sf daemon` (`SF_API_URL` set) → the run page shows live events over `wss://` via the web proxy
- `pnpm exec wrangler tail sf-api` for errors

**Phase 2 resources created later (stage 17, not 14):**
- queues `sf-index`, `sf-index-dlq`
- Vectorize `sf-brain` (+ metadata indexes) and `sf-brain-dev`
- AI Gateway `sf`
- secrets `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`
- the org webhook in GitHub
