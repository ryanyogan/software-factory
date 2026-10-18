# Software Factory — build handoff

Source plan: `.handoff/plan.md` (exported from the "Software Factory — Research & Product Plan" doc).
Every sub-agent: read this file first, do ONLY your stage, then append a section under "Stage log" with
what you did, exact commands that work (dev/build/test/lint), and anything the next stage must know.

## Goal of this build: Phase 0 "Foundations"

Scope: contract package, auth, D1 schema, CLI skeleton, CI perf budget.
Gate: the `sf` CLI and the web GUI call ONE API for `task.create` and `run.start`.
UI: start simple (shadcn defaults, dense, dark+light). A bold visual direction comes later — do not invest in it.

## Locked decisions (from user)

- pnpm workspaces monorepo.
- VoidZero tooling: Vite, Vitest, Oxlint, Oxfmt, tsdown/Rolldown; use Vite+ (`vp`) if research confirms it's usable. NOT Biome/Turborepo (overrides the plan doc).
- TanStack Start on Cloudflare Workers (@cloudflare/vite-plugin). Use TanStack's agent skills (TanStack Intent) and the Cloudflare skills (`cloudflare:workers-best-practices`, `cloudflare:wrangler`, `cloudflare:durable-objects`, `cloudflare:agents-sdk`).
- shadcn/ui for UI, using shadcn's skills/CLI; components live in `packages/ui`.
- Layout per plan: apps/{web,api,mcp,cli}, packages/{contract,core,db,adapters,brain,ui,config}. Only create brain/adapters as empty stubs in Phase 0.
- D1 + Drizzle. Durable Objects `ProjectRoom` and `RunLog` exist as skeletons.
- CLI binary name `sf` (placeholder). Project dir: ~/code/software-factory.
- Fetch current docs with Context7 before using any version-dependent API.

## Stage log

(append below)

### Stage: research (2026-10-17)
- Wrote `.handoff/research.md` (versions, config snippets, commands; UNVERIFIED items marked). No project code written.
- Vite+ is stable (`vite-plus@1.3.0`): use it locally (`pnpm add -Dw vite-plus`, pnpm overrides `vite: npm:@voidzero-dev/vite-plus-core@1.3.0`, `vitest: 5.0.5`), root `vite.config.ts` for lint/fmt/staged, `vp check`, `vp test`, `vp run -r build`, `vp pack` for the CLI. Smoke-test TanStack Start + @cloudflare/vite-plugin under vite-plus-core early; fallback = oxlint/oxfmt/vitest + `pnpm -r`.
- Stack: @tanstack/react-start 1.169.3, @cloudflare/vite-plugin 1.64.0, wrangler 4.151.1, compat date 2026-10-01; apps/api = Worker with named `WorkerEntrypoint` (RPC) + fetch (REST for CLI) + SQLite DOs; web→api via service binding RPC; dev = single `vite dev` with `auxiliaryWorkers`.
- Data/auth: drizzle-orm 0.45.4 / drizzle-kit 0.31.11, migrations in packages/db/drizzle applied by `wrangler d1 migrations apply DB --local`; better-auth 1.7.10 + @better-auth/drizzle-adapter, GitHub OAuth, `deviceAuthorization()` + `bearer()` for `sf login`. CLI: citty 0.2.2. Skills: `npx @tanstack/intent@latest install`, `npx skills add shadcn/ui`.

### Stage 2: monorepo foundation + shared packages (2026-10-17)

**Smoke test (passed, so Vite+ stays):** a throwaway `@tanstack/cli create web --deployment cloudflare --blank` app with
`overrides: { vite: npm:@voidzero-dev/vite-plus-core@1.3.0, vitest: 5.0.5 }` + `vite-plus@1.3.0` →
`vp build` OK (client + `dist/server/wrangler.json`), and `vp dev` SSR returned HTTP 200. The only noise is
peer warnings (vite "1.3.0" vs `^8`), silenced with `peerDependencyRules.allowedVersions.vite: '*'`. The throwaway was deleted.
The scaffold's own `vite.config.ts` uses `resolve: { tsconfigPaths: true }` + `cloudflare({ viteEnvironment: { name: 'ssr' } })`, `tanstackStart()`, `viteReact()`.

**What exists**
- Root: `package.json` (pnpm@11.17.0, scripts below, `intent.skills: ["@tanstack/*"]`), `pnpm-workspace.yaml` (apps/*, packages/*, overrides, `peerDependencyRules`, `allowBuilds`), root `vite.config.ts` (lint/fmt/staged), `tsconfig.json` (root config only), `.gitignore`, `.editorconfig`, `.nvmrc` (24), `AGENTS.md` (the intent-skills block sits at the top, then the layout/commands), `CLAUDE.md` (`@AGENTS.md`), `.claude/skills/{shadcn,migrate-radix-to-base}` + `skills-lock.json` (from `npx skills add shadcn/ui --skill '*' --agent claude-code -y`).
- `packages/config/tsconfig.base.json`: strict, Bundler resolution, `noEmit`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `types: []`. Each package extends `@sf/config/tsconfig.base.json` and adds `types`/`lib`.
- `packages/contract` (`@sf/contract`, zod 4.6.7), `packages/db` (`@sf/db`, drizzle-orm 0.45.4 / drizzle-kit 0.31.11), `packages/core` (`@sf/core`), plus stubs `@sf/ui`, `@sf/adapters`, `@sf/brain`. `apps/` is empty (`.gitkeep`).
- Internal packages export TS source (`"exports": { ".": "./src/index.ts" }`) and have no build step. Imports inside packages are extensionless.

**Commands (all from repo root; all pass)**
- `pnpm install` (and `--frozen-lockfile`)
- `pnpm check` → `vp check` (fmt check + oxlint type-aware + type-check). Fix with `pnpm fmt` / `pnpm exec vp check --fix`.
- `pnpm test` → `vp run -r test` (contract: 3 tests, core: 5 tests). Package script = `vp test run`.
- `pnpm typecheck` → `vp run -r typecheck` (`tsc --noEmit` per package, TypeScript 7.0.2 native).
- `pnpm build` → `vp run -r build` (no-op until apps exist).
- `pnpm --filter @sf/db db:generate --name <name>` → writes `packages/db/drizzle/NNNN_<name>.sql`. Initial: `0000_init.sql`.

**Contract API (`@sf/contract`)**
- Schemas: `Project`, `Task`, `TaskStatus`, `Run`, `Agent`, `RunLocation`, `RunState`, `Id`, `Timestamp` (ISO string). zod schema and TS type share a name.
- `defineCommand({ name, summary, input, output, http: { method, path } }): CommandDef`.
- `commands` registry keyed by name: `project.create`, `project.list`, `task.create` ({projectId, title, branch?}), `task.list` ({projectId?}), `run.start` ({taskId, agent, location='local'}), `run.get` ({id}), `run.list` ({taskId?}). List outputs are wrapped: `{ projects }`, `{ tasks }`, `{ runs }`.
- Types: `CommandName`, `CommandInput<N>` (pre-defaults), `ParsedInput<N>`, `CommandOutput<N>`, plus `commandNames` and `isCommandName(s)`.
- `CommandError(code, message, issues?)` with `.status` (HTTP) and `.toBody()` → `{ error: { code, message, issues? } }`. Codes: `unknown_command | invalid_input | invalid_output | not_found | unauthorized | internal`.
- `createClient({ baseUrl, fetch?, token? }).call(name, input)` sends **`POST ${baseUrl}/v1/commands/<name>`** with a JSON body and `Authorization: Bearer <token>` (token can be a string or a function), validates the output, and throws `CommandError` from the error body. `commandPath(name)` is exported. **The api must serve `POST /v1/commands/:name`**. Each def's `http.method/path` (e.g. `POST /v1/tasks`, `GET /v1/runs/:id`) is canonical REST metadata. Implementing those routes is optional, but the client does not use them.

**Core API (`@sf/core`)**
- `type Ctx = { db: Db; userId: string; now?: () => Date; newId?: (prefix) => string }`. `Db = BaseSQLiteDatabase<'async', unknown, typeof schema>`, so `createD1Db(env.DB)` from `@sf/db` fits.
- `handlers[name](ctx, parsedInput) => Promise<CommandOutput<name>>`.
- `dispatch(ctx, name, rawInput)` validates input (`invalid_input`), runs the handler, and validates output (`invalid_output`). Unknown name → `unknown_command`. Missing project/task/run → `not_found`. In HTTP: `catch (e) { if (e instanceof CommandError) return Response.json(e.toBody(), { status: e.status }) }`.
- IDs are `prj_|tsk_|run_` + a uuid without dashes. `task.create` defaults `branch` to `sf/<slug(title)>`. `run.start` sets `state: 'queued'` and `startedBy: ctx.userId`.

**DB (`@sf/db`)**: tables `projects`, `tasks` (FK→projects, cascade), `runs` (FK→tasks, cascade). Timestamps are `integer` ms (`mode: 'timestamp_ms'`) and become ISO strings in core. Exports `schema`, the tables, the `*Row` types, `createD1Db(d1)`, and `D1Db`; `@sf/db/schema` is a subpath. **Stage 3:** generate the Better Auth tables into `packages/db/src/auth-schema.ts`, re-export them from `schema.ts`, make `runs.started_by` reference `user.id` if wanted, and run `db:generate --name auth`.

**Gotchas**
- pnpm 11 ignores the `"pnpm"` field in package.json. Overrides, `allowBuilds`, and `peerDependencyRules` go in `pnpm-workspace.yaml`. The TanStack scaffold also emitted a `minimumReleaseAgeExclude` list for very fresh @tanstack versions. If installing a just-published package fails, add it there.
- Tests import from `vite-plus/test`. Packages resolve `vite-plus` from the root devDeps. Core tests use **libsql in-memory** (`@libsql/client` + `drizzle-orm/libsql` + `migrate()` from `packages/db/drizzle`). It is async like D1 and has no native build.
- `D1Database` is typed via drizzle's `AnyD1Database`, so packages that don't load `@cloudflare/workers-types` still typecheck.
- Lint and fmt ignore `.claude/**`, `.handoff/**`, `**/drizzle/**`, `**/routeTree.gen.ts`, and `**/worker-configuration.d.ts`. The shadcn skill ships `.tsx` assets that fail type-aware lint otherwise.
- `npx @tanstack/intent install` fails non-interactively unless `package.json` has `intent.skills`. It was set to `["@tanstack/*"]`, and `@tanstack/intent` is a root devDep so `pnpm exec intent list` works. It reports no skills until apps add @tanstack deps; re-run `pnpm exec intent install` after scaffolding apps/web.
- `staged` is configured, but no git hook is installed (`vp staged` is not wired to husky or a hook yet).
- When adding apps: per-app `vite.config.ts` may import `defineConfig` from `vite` or `vite-plus`. Give each app `typecheck`/`build`/`test` scripts so `vp run -r` picks them up. Do not add a direct `vite` dependency at a different version.

### Stage 3: apps/api — `sf-api` Worker (2026-10-17)

**What exists**: `apps/api` (`@sf/api`): Hono 4.13.13 app (default export), `ApiRpc` WorkerEntrypoint, `ProjectRoom` + `RunLog` SQLite DOs (hibernatable WS), Better Auth 1.7.10 (drizzle adapter on D1, GitHub, `bearer()`, `deviceAuthorization({ verificationUri: '/device', validateClient: id === 'sf-cli' })`), dev auth bypass. Better Auth tables are in `packages/db/src/auth-schema.ts` (re-exported from `schema.ts`), migration `packages/db/drizzle/0001_auth.sql`. `runs.started_by` has NO FK to `user` (kept core tests user-free).
Core change: `Ctx.events?: EventsPort` (`appendRunEvent(runId, {type, payload})`); `run.start` appends `run.started` (payload = the Run). `EventsPort`, `RunEvent` exported from `@sf/core`.

**Endpoints** (all on the same `runCommand` path in `src/commands.ts`):
- `GET /v1/health` → `{ ok: true, service: 'sf-api' }`
- `POST /v1/commands/:name` (JSON body) → output JSON | `{ error: { code, message, issues? } }` with `CommandError.status` (unknown_command 404, invalid_input 400, not_found 404, unauthorized 401, internal 500)
- `GET|POST /api/auth/*` → Better Auth (`/api/auth/device/code`, `/api/auth/device/token`, `/api/auth/callback/github`, ...). Verified: `/api/auth/ok` 200, `device/code` with `client_id: sf-cli` 200, other client_id → 400 invalid_client.
- `GET /v1/runs/:id/events?since=<seq>` WebSocket → RunLog (replays seq > since, then live). Messages: `{ seq, type, payload, at }` JSON; `ping` → `pong`.
- `GET /v1/projects/:id/room` WebSocket → ProjectRoom (relay skeleton). Both WS routes require a user (cookie/bearer/dev bypass).

**RPC signature** (`apps/api/src/rpc.ts`; `src/index.ts` exports `ApiRpc`, types `RpcAuth`, `CommandResult`, `StoredRunEvent`):
```ts
class ApiRpc extends WorkerEntrypoint<Env> {
  command(name: string, input: unknown, auth?: {
    headers?: [string, string][];   // forward [...request.headers] (cookie/authorization)
    sessionToken?: string;          // sent as Authorization: Bearer
    origin?: string;                // new URL(request.url).origin; dev bypass is loopback-only
  }): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: { code; message; issues? } }>
}
```
It returns a union instead of throwing (custom error classes don't survive RPC). On `ok: false`, web should rebuild `new CommandError(error.code, error.message, error.issues)`; cast `data` to `CommandOutput<N>`.
RunLog RPC: `env.RUN_LOG.getByName(runId).append({type, payload})` → `StoredRunEvent`; `.list(since?)`.

**Env vars** (`apps/api/.dev.vars.example` → copy to `.dev.vars`, gitignored): `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (also wrangler `vars` = http://localhost:8787), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (GitHub provider registered only when both are set), `SF_DEV_AUTH=1`.
**Dev bypass**: no valid session + `SF_DEV_AUTH === '1'` + request origin hostname ∈ {localhost, 127.0.0.1, ::1} → user `dev` (`dev@localhost`, inserted with ON CONFLICT DO NOTHING on first use). A valid cookie/bearer session always wins. Non-loopback host → 401 (tested over HTTP and RPC).

**Commands**
- `pnpm --filter @sf/api db:migrate:local` (= `wrangler d1 migrations apply DB --local`; state in `apps/api/.wrangler/state`)
- `pnpm --filter @sf/api dev` → `wrangler dev --port 8787`
- `apps/api/scripts/smoke.sh [base]`: curl smoke against a running dev server (health, project.create, task.create, run.start, run.list, 404/400 mapping, WS replay of `run.started`)
- `pnpm --filter @sf/api test` → `@cloudflare/vitest-plugin@1.4.4` works with vitest 5.0.5 / vite-plus. Import `cloudflareTest, readD1Migrations` from `@cloudflare/vitest-plugin` (NOT `/config` as the docs say). 7 tests: HTTP, error mapping, bypass refusal, RunLog append + WS replay, ApiRpc parity. Migrations applied in `test/apply-migrations.ts`.
- `pnpm --filter @sf/api cf-typegen` (= `wrangler types --env-file .dev.vars.example`, deterministic; run by `typecheck`). `worker-configuration.d.ts` is committed. `typecheck` also runs `tsc -p test`.
- `pnpm --filter @sf/api auth:schema` regenerates `packages/db/src/auth-schema.ts` from `scripts/auth-schema.config.ts` (mirror plugin changes there!), then `pnpm --filter @sf/db db:generate --name <x>`.

**Gotchas / for the web stage**
- Do NOT import `drizzle-orm` directly in apps: better-auth's kysely peer makes pnpm install a second drizzle-orm instance → type clash. Use `createD1Db` from `@sf/db`.
- Root lint: `typescript/await-thenable` is off for `apps/api/**` (false positive on RPC stubs' `Rpc.Result`). fmt/lint ignore `worker-configuration.d.ts` and `.wrangler`.
- Web binding (apps/web/wrangler.jsonc): `"services": [{ "binding": "API", "service": "sf-api", "entrypoint": "ApiRpc" }]`; web needs no D1 binding. vite.config: `cloudflare({ viteEnvironment: { name: 'ssr' }, auxiliaryWorkers: [{ configPath: '../api/wrangler.jsonc' }] })`. Types: `wrangler types -c wrangler.jsonc -c ../api/wrangler.jsonc` should give `API: Service<import('../api/src/index').ApiRpc>`.
- With auxiliaryWorkers the api's D1/DO state likely lives in apps/web's `.wrangler/state`. Apply migrations with `wrangler d1 migrations apply DB --local -c ../api/wrangler.jsonc --persist-to .wrangler/state` (UNVERIFIED; confirm). Confirm where the vite plugin reads the auxiliary worker's `.dev.vars` from (likely `apps/api/.dev.vars`; UNVERIFIED).
- Web must forward `origin: new URL(request.url).origin` for the dev bypass (localhost:5173 qualifies) and `headers: [...request.headers]` for cookie sessions.
- Browser sign-in: the auth origin should be the web origin. Proxy `/api/auth/*` from web via `env.API.fetch(request)` and set `BETTER_AUTH_URL` to the web origin (http://localhost:5173) when running under web; GitHub callback = `<web origin>/api/auth/callback/github`. The device flow `verification_uri` = BETTER_AUTH_URL + `/device`, so web needs a `/device` page (approve/deny client API unverified).
- The bearer path (`Authorization: Bearer <session token>` → `auth.api.getSession({ headers })`) is wired but was not exercised end to end (no GitHub app). The CLI stage should verify it after `sf login`.
- `database_id` in wrangler.jsonc is a placeholder `00000000-...`; replace it after `wrangler d1 create sf` before any deploy. Nothing remote was created.

### Stage 4: apps/web (`sf-web`) + packages/ui (2026-10-17)

**What exists**
- `apps/web` (`@sf/web`): TanStack Start 1.169.3 on Workers, hand-written (the `@tanstack/cli` scaffold was used as a reference only). `wrangler.jsonc`: main `@tanstack/react-start/server-entry`, nodejs_compat, 2026-10-01, observability + traces, service binding `API` → `sf-api` / `ApiRpc`. `vite.config.ts` (from `vite-plus`): cloudflare plugin (`viteEnvironment: ssr`, `auxiliaryWorkers: ../api/wrangler.jsonc`, `persistState` → `apps/api/.wrangler/state`), tailwind v4, tanstackStart, react. Plugins are skipped when `mode === 'test'` so unit tests run in plain Node.
- `packages/ui` (`@sf/ui`): shadcn 4.22 monorepo layout, style `radix-nova` (Radix base, lucide, neutral), copied from `shadcn init -t start --monorepo --preset nova --base radix` minus Turborepo. Both `components.json` (packages/ui + apps/web) match. Imports are subpaths: `@sf/ui/components/<x>`, `@sf/ui/lib/utils`, `@sf/ui/hooks/use-mobile`, `@sf/ui/globals.css`. Add components with `pnpm dlx shadcn@4.22.0 add <name>` **from apps/web** (it writes into packages/ui). Gotcha: shadcn put `use-mobile.ts` into apps/web/src/hooks; it was moved to packages/ui/src/hooks (move any future hooks the same way). Components: button input label card table badge dialog select sonner sidebar(+sheet) command skeleton tooltip dropdown-menu field empty separator kbd input-group textarea.
- Theme: one token set (shadcn neutral) in `packages/ui/src/styles/globals.css`, `.dark` class; `system` default + toggle (header button / cmd-k "Toggle theme"), stored in `localStorage.theme`, no-flash inline script (`apps/web/src/components/theme.tsx`).

**Routes** (`apps/web/src/routes`)
- `/`: "Needs you" (runs in queued/blocked/review, from `run.list`)
- `/projects`: list + create dialog; `/projects/$projectId`: tasks + "New task"; `/tasks/$taskId`: runs + "Start run" (agent claude-code|codex|opencode, location local|cloud); `/runs/$runId`: state badge + live events table.
- Server routes: `/v1/$` (ANY) → `env.API.fetch(request)`, which covers REST, `/v1/commands/:name`, and **WebSocket upgrades**. `/api/auth/$` (GET/POST) → `env.API.fetch`.
- Every action shows a copy-as-CLI box (`src/lib/cli.ts`, POSIX single-quoting), e.g. `sf task create --project prj_… --title 'Add login page'`. cmd-k / ctrl-k palette: New project, go to Needs you / Projects / each project, toggle theme. `g h` / `g p` key chords. The header shows the viewer (`dev` via bypass) and a menu with "Sign in with GitHub" (`authClient.signIn.social`; needs OAuth creds, untested).

**Data path (same as CLI)**: `src/lib/commands.ts` has ONE `createServerFn` POST `commandFn({ name, input })` → `rpcCommand` (`src/lib/api.server.ts`) → `env.API.command(name, input, { headers: [...request.headers], origin })` → api `runCommand`. `unwrap()` (`src/lib/result.ts`) validates output with the contract schema or rebuilds `CommandError`. `src/lib/queries.ts` has `queryOptions` per command (keys = command names), plus mutations that invalidate (`useCreateProject/useCreateTask/useStartRun`). Router: per-request QueryClient + `@tanstack/react-router-ssr-query`; loaders `ensureQueryData`, components `useSuspenseQuery`.
Live events: `src/lib/run-events.ts`. The browser opens `ws(s)://<web origin>/v1/runs/:id/events?since=<lastSeq>` (proxied through web's `/v1/$` route; this works in dev), merges events into the `['run.events', id]` cache (deduped by seq), patches `['run.get', id]` when the payload is a Run, and reconnects with backoff.

**api change (stage 3 code)**: a service binding to a *named entrypoint* sends `env.API.fetch()` to that entrypoint's `fetch`, so `ApiRpc` now has `fetch()` that delegates to the Hono app. The app moved to `apps/api/src/app.ts`; `index.ts` re-exports it as default. api tests still pass (7).

**Dev / DB state (resolves stage 3's open question)**
- `pnpm dev` (root) = `pnpm --filter @sf/web dev` = `vp dev` on **http://localhost:5173**, running sf-web + sf-api (auxiliary) in one Miniflare.
- Local state: the vite plugin's `persistState` points at **`apps/api/.wrangler/state`**, the same dir `wrangler dev` in apps/api uses. So there is one local D1 + DO store and one migrate command: **`pnpm db:migrate:local`** (root → `pnpm --filter @sf/api db:migrate:local`). Verified: data created via `wrangler dev` (8787) is visible on 5173, even with both running at once. Caveat: DO live sockets are per process, so a WS opened on 5173 won't see events appended by the 8787 process. Use one server per flow.
- Without `persistState` the aux worker's state would live in `apps/web/.wrangler/state` (the default). Migrations there would need `--persist-to ../web/.wrangler/state` (verified to work, but no longer used).
- The aux worker reads its vars from **`apps/api/.dev.vars`** ("Using secrets defined in ../api/.dev.vars"). `vp build` copies it into `apps/web/dist/sf_api/.dev.vars` (dist is gitignored). `BETTER_AUTH_URL` is still http://localhost:8787. For GitHub sign-in via web, set it (and the GitHub callback) to http://localhost:5173.
- Verified (headless chromium + playwright-core script; the Playwright MCP needs `/opt/google/chrome`, which isn't installed): create project → create task → start run (codex/local) → run page shows `run.started` over a live WS, cmd-k nav, dark toggle, no console errors. Screenshot: `.handoff/screens/run.png`.

**Commands**: `pnpm --filter @sf/web dev|build|test|typecheck|cf-typegen`. `cf-typegen` = `wrangler types -c wrangler.jsonc -c ../api/wrangler.jsonc` → `API: Service<typeof import("../api/src/index").ApiRpc>`. `pnpm check|typecheck|test|build` all pass (1 lint warning from stock shadcn `use-mobile`).

**Gotchas**
- Use `vp dev` / `vp build` in app scripts: there is no `vite` bin (vite is aliased to vite-plus-core and not a direct dep). tsconfig `types` uses `vite-plus/client`, not `vite/client`.
- Web's tsconfig also loads `../api/worker-configuration.d.ts`. web type-checks api source (pulled in by the typed binding), and that source needs the api's `Env`. The global `Env` interfaces merge, so web *code* sees api bindings in its types too. Only `env.API` exists at runtime in web.
- Server-fn return types must be serialisable: the RPC result is typed as `Json` (`RpcResult` in api.server.ts) and round-tripped through JSON.
- `routeTree.gen.ts` is regenerated by dev/build. It is committed but ignored by fmt/lint.
- Dates render as UTC during SSR and switch to local after hydration (`<Time>` in components/page.tsx) to avoid hydration mismatches.
- lucide-react 1.x has no brand icons (no `GithubIcon`).
- Root lint: `typescript/await-thenable` is also off for `apps/web/**` (RPC stub false positive).

**For stage 5 (CLI)**
- Point the CLI at either `http://localhost:5173` (web dev; `/v1/*` is proxied, including WS) or `http://localhost:8787` (`pnpm --filter @sf/api dev`). Both hit the same `runCommand` and, locally, the same D1. `createClient({ baseUrl })` from `@sf/contract` works against both. Verified with curl `POST /v1/commands/project.list` on both.
- The GUI's copy-as-CLI strings (`apps/web/src/lib/cli.ts`, tested in `cli.test.ts`) already assume the exact syntax: `sf project create --name X [--repo URL]`, `sf project list`, `sf task create --project ID --title T`, `sf task list --project ID`, `sf run start --task ID --agent A --location L`, `sf run list [--task ID]`, `sf run get ID`. Keep the CLI flags identical (or update cli.ts + its test).
- Device flow: `verification_uri` = BETTER_AUTH_URL + `/device`. **No `/device` page exists in web yet.** Add it with `sf login`. `/api/auth/*` is already proxied by web.
- `run get` output: the web run page also shows events, but there is no `run.events` command. The CLI can tail `/v1/runs/:id/events` (WS) the same way `run-events.ts` does.

### Stage 5: apps/cli (`sf`) + /device + WS origin guard + gate (2026-10-17)

**CLI (`apps/cli`, `@sf/cli`, bin `sf`)**: citty 0.2.2, `vp pack` → `dist/cli.mjs` (+ lazy chunks; ~30 ms `--help`). All deps are devDependencies, so tsdown bundles everything (`deps.onlyBundle: ['citty','zod']`) and `node apps/cli/dist/cli.mjs` runs standalone. Root `pnpm sf ...` runs it.
- `src/cli.ts` imports only citty; subcommands are `() => import(...)`. Global `--json` / `--api` (spread from `src/args.ts` into every leaf). API url: `--api` > `SF_API_URL` > http://localhost:5173. Token: `SF_TOKEN` env > `~/.config/sf/config.json` (`SF_CONFIG_DIR` / `XDG_CONFIG_HOME` honoured; written 0600, dir 0700).
- Data commands → `createClient` from @sf/contract only (`src/client.ts`); arg→input mapping in `src/inputs.ts`; tables/records in `src/format.ts` + `src/output.ts` (`action()` = json|human output, errors → stderr / `{error}` JSON + exit 1).
- `sf login` (`src/login.ts`): `/api/auth/device/code` (client_id `sf-cli`) → prints `verification_uri_complete` + user code on stderr → polls `/api/auth/device/token` (pending / slow_down +5s / denied / expired) → `GET /api/auth/get-session` with Bearer → saves `{token, apiUrl, user}`. `sf whoami` = get-session with Bearer (no dev bypass on that endpoint, so success proves the bearer path). `sf logout` = best-effort `/api/auth/sign-out` + delete config. `sf watch RUN_ID [--since N]` = Node WebSocket (undici, `headers: { authorization }`, no Origin) to `/v1/runs/:id/events`; exits on merged/abandoned or ctrl-c; `--json` = NDJSON.
- Note: `project.create` requires `repoUrl` in the contract, so `sf project create` without `--repo` fails with `invalid_input` (flag stays optional to match the GUI's copy-as-CLI syntax).
- Tests: `apps/cli/src/cli.test.ts` (21; fetch stubbed, runs real citty commands).

**api**
- CSWSH fix (`src/origins.ts`, used by `requireWsUser` in `app.ts`): WS upgrades with an `Origin` must match `WEB_ORIGIN` (comma-separated; wrangler var + default `http://localhost:5173,http://localhost:8787`) else 403; no-Origin upgrades have `cookie` stripped (Bearer or loopback dev bypass only). Tests: allowed origin 101, foreign origin 403 even with bearer, no-origin + bearer 101 on a non-loopback host, cookie stripping.
- `BETTER_AUTH_URL` is now http://localhost:5173 (wrangler vars, `.dev.vars.example`, local `.dev.vars`); `trustedOrigins: webOrigins(env)`. Bearer with the raw session token works (verified in tests + live).
- Dev sign-in (`src/dev-sign-in.ts`): Better Auth plugin endpoint `POST /api/auth/dev/sign-in`, registered only when `SF_DEV_AUTH=1`, loopback-only → creates a REAL session cookie for `dev` (device approve needs a real session; the header-less dev bypass isn't one). Must send a JSON body. Loopback check moved to `isLoopback()` in origins.ts.
- Gotcha: through the vite dev proxy (5173), a rejected (403) WS upgrade shows up as an empty reply, not a 403; direct-to-api it's a 403.

**web**: `/device` route (`src/routes/device.tsx`): `?user_code=` prefill → needs session (GitHub button, or "Continue as dev user" on loopback) → `authClient.device({query})` → Approve/Deny (`authClient.device.approve/deny({ userCode })`). `auth-client.ts` adds `deviceAuthorizationClient()` + `devSignIn()`. Screenshot `.handoff/screens/device.png`.

**Verified live (pnpm dev, 5173)**: `sf login` → headless chromium (playwright-core from scratch dir, /usr/bin/chromium) dev sign-in + approve → CLI "Logged in as dev@localhost", config 0600; `sf whoami` OK via Bearer, bogus `SF_TOKEN` → error exit 1; project/task/run create/list/get human + json; `sf watch` streams `run.started` with Bearer through web's `/v1/$` proxy; browser-origin WS upgrade 101, foreign origin rejected.

**Gate**: `pnpm gate` (= `bash scripts/gate.sh`) refuses if 5173 is already serving, migrates, builds CLI if needed, `setsid pnpm dev`, CLI `--json` project→task→run, `sf run list`, then `GET /tasks/<id>` HTML (SSR loader → `commandFn` server fn → `ApiRpc.command`) must contain the run id; kills the process group on exit. PASSES.

**Note**: a `wrangler dev --port 8787` (pid 2187730, started 11:13, not by stage 5) was running throughout; left alone.

### Stage 6: repoUrl optional, mcp stub, perf budget, CI, README (2026-10-17)

- **`project.create` repoUrl optional**: contract input `repoUrl: z.url().optional()`, `Project.repoUrl` is `z.url().nullable()` on the wire; core stores `null`; `projects.repo_url` nullable. Migration `0002_nullable_repo_url.sql` is **hand-edited**: drizzle-kit generated a table rebuild (`DROP TABLE projects`), which on D1 (FKs always enforced, `PRAGMA foreign_keys=OFF` ignored) cascades and deletes every task/run. It now adds `repo_url_new`, copies, drops the old column, renames. Verified on local state (tasks kept). Keep the drizzle snapshot as generated. Web dialog field is "(optional)", no `required`; CLI prints `-` for no repo. Tests: core (create without repo → null), CLI mapping (`create --name Demo` → `{name}`).
- **apps/mcp** (`@sf/mcp`): stub package (typecheck only) + README: McpAgent server lands in Phase 2, tools generated from @sf/contract.
- **Perf budget**: `pnpm perf` = `node scripts/perf-budget.mjs` (after `pnpm build`), budgets in `perf-budget.json`. Measured: CLI `--help` median of 11 = ~31–37 ms (budget 150); web initial JS gzip (entry from the TanStack Start manifest in `dist/server/assets/_tanstack-start-manifest*` + static-import closure = `__root__` preloads) 229.7 KiB (budget 287); total client JS gzip 238.1 KiB (budget 298). Budgets = 1.25x baseline; raise `baseline`/`budget` deliberately. Plan latency targets listed with `measured: false`. Note: the initial bundle is large (react-dom + router + query + shadcn in `index`/`page` chunks) — a Phase 1 target.
- **CI** `.github/workflows/ci.yml`: pnpm/action-setup@v4 (version from packageManager), setup-node@v4 node 24 + pnpm cache, frozen install, check, typecheck, test, build, perf, `cp .dev.vars.example .dev.vars`, gate. No browser, no secrets. Commented-out deploy job (CLOUDFLARE_API_TOKEN). Action versions are from memory, not docs.
- api scripts added: `db:migrate:remote`, `deploy` (`wrangler deploy`). Root `README.md` with quickstart, commands, layout, Phase 1, deploy checklist.
- Plan export is missing the Roadmap table (only the intro paragraph survived); README's "What's next" is derived from the v1 capability list.
- All pass locally: check, typecheck, test (50), build, perf, gate.

---

## Goal of this build: Phase 1 "Local loop" (started 2026-10-17)

From the plan doc's roadmap widget (lost in the export): **1 · Local loop, 5 weeks. Scope: daemon wraps Claude Code and Codex;
live run view, worktrees, PRs. Gate: 5 engineers use it daily for a full week.** Later phases (do NOT build now): 2 brain + MCP +
skills sync; 3 cloud Sandbox, `sf push`/`sf pull`, preview URLs, embedded terminal; 4 final review gate, Slack; 5 replace Obvious.

The human gate can't be automated, so the **technical gate** for this build is `pnpm gate:local` (stage 12): dev server + `sf daemon`
running; in a temp git repo `sf run start` with the `fake` agent → daemon claims it, makes the task worktree, agent events stream to
the RunLog, the web run page shows transcript + per-turn diff, a follow-up message sent through the API reaches the agent, the run
ends in `review` with a commit on the task branch and a PR recorded (PR provider faked in the gate). Measure "local agent event to
GUI" p95 against the 250 ms budget and record it in `perf-budget.json`.

### Phase 1 decisions (chosen by the orchestrator; revisit only with evidence)
1. **Daemon** = `sf daemon`, a long-running Node process in `apps/cli` (lazy-imported subcommand). It serves the local repos linked
   with `sf link` (config maps repo path ↔ projectId). It learns about queued `local` runs over a WebSocket (ProjectRoom broadcast
   per linked project, no polling) and claims one atomically with a `run.claim` command (D1 conditional update). One daemon per machine.
2. **Adapters** (`packages/adapters`) use official SDKs, not screen-scraping: Claude Code via `@anthropic-ai/claude-agent-sdk`,
   Codex via `@openai/codex-sdk`, plus a scripted `fake` adapter for tests/gate. OpenCode is deferred. Every adapter emits one
   normalized `AgentEvent` union defined in `@sf/contract` (assistant text, tool call/result, usage+cost, error, turn end, session id
   for resume). Adapters accept follow-up user messages mid-run (or resume the session between turns).
3. **Worktrees**: one per Task on the task's `branch`, at `$XDG_DATA_HOME/sf/worktrees/<projectId>/<taskId>` (default
   `~/.local/share/sf/...`), reused across that task's runs. Agents run with cwd = worktree, in an auto-edit permission mode scoped
   to it.
4. **Events**: the daemon writes to RunLog over WebSocket (bidirectional: it also receives follow-ups/cancel from the same socket),
   with an HTTP batch endpoint as fallback. After each agent turn the daemon appends a `diff.snapshot` (git diff vs the base).
   Run state transitions (queued → running → review/failed/abandoned) go through contract commands so all surfaces agree.
5. **PRs**: at run end the daemon commits to the task branch; with `openPr` (default true when the repo has a GitHub remote) it
   pushes and opens a draft PR with the local `gh` CLI behind a `PrProvider` interface (faked in tests/gate), and records `prUrl`.
6. **Live run view** (web): transcript, tool calls, per-turn unified diff, state, cost, PR link, a follow-up box (steer), cancel.
   Terminal and preview are Phase 3. Every new action keeps the copy-as-CLI box.
7. **Context resolution** for `sf run` in a repo: cwd → linked project (or git remote → `project.repoUrl`), branch → task.
8. Real agents: tests never spend tokens. Each adapter gets ONE manual smoke run with a trivial prompt in a throwaway repo.
9. Each stage ends with `pnpm check && pnpm typecheck && pnpm test && pnpm build && pnpm gate` passing and one local git commit
   (no remote exists; never push).

### Phase 1 stages
- 7 research → `.handoff/phase1-research.md`
- 8 contract + core + db + api: run lifecycle, AgentEvent/RunEvent schemas, `run.claim`/`run.update`/events ingest, daemon WS, ProjectRoom broadcast
- 9 `packages/adapters`: claude-code, codex, fake
- 10 `sf daemon`, `sf link`, `sf run` context resolution, worktrees, diff snapshots, follow-ups, commit/PR, `sf open`
- 11 web live run view + Needs-you updates
- 12 `pnpm gate:local`, perf measurement, README/AGENTS updates

### Stage 7: Phase 1 research (2026-10-17)
- Wrote `.handoff/phase1-research.md` (no project code). Versions: `@anthropic-ai/claude-agent-sdk@0.3.302` (bundles Claude Code 2.1.302), `@openai/codex-sdk@0.163.0` (bundles codex 0.163.0), node 24.22, git 2.55, gh 2.102.
- Auth VERIFIED: Claude SDK reuses the local Claude Code login (probe with ANTHROPIC_API_KEY stripped → `accountInfo()` = Claude Max, no tokens spent); Codex SDK reuses `~/.codex/auth.json` (ChatGPT login) when no `apiKey` is passed. No API keys needed. Strip `ANTHROPIC_API_KEY` from the agent env unless opted in.
- Both SDKs resolve a native binary from a platform optional dep (273 MB + 411 MB): keep them external to the tsdown CLI bundle, lazy-import in `sf daemon`; can point at local CLIs via `pathToClaudeCodeExecutable` / `codexPathOverride`. `env` option REPLACES process.env in both SDKs.
- Claude: streaming input (async-iterable prompt) gives mid-run follow-ups, `interrupt()`, `abortController`, `resume: sessionId`. Codex: each turn = new `codex exec --experimental-json [resume id]` process; no mid-turn steering — follow-up = next `runStreamed` on the same Thread; cancel via `TurnOptions.signal`.
- D1: `db.update(runs).set(...).where(and(eq(id), eq(state,'queued'))).returning()` VERIFIED atomic-claim semantics on drizzle 0.45.4 (libsql). Schema lacks `failed` state and claim/session/pr columns; adding them must not trigger a table rebuild.
- DO: use `acceptWebSocket(ws, [role])` tags + `serializeAttachment` (≤16 KiB) for per-socket identity, `getWebSockets('daemon')` to relay control frames, `setWebSocketAutoResponse` for ping/pong. Diff incl. untracked via a temp `GIT_INDEX_FILE` (no index side effects); push before `GH_PROMPT_DISABLED=1 gh pr create --draft --head --base --title --body-file -` (URL on stdout).

### Stage 8: run lifecycle + events backend (2026-10-17)

**Where things live**
- `packages/contract/src/events.ts`: `AgentEvent` (research §3: `session.started | message | reasoning | tool.call | tool.result(+truncated) | file.change | todo | turn.completed | error`, `AgentUsage.costUsd` = per-turn delta), `runEventPayloads` (type → payload schema), typed `RunEvent` union, loose `StoredRunEvent` (`{seq, type, payload, at, emittedAt?}`, what RunLog returns), `parseRunEvent(raw) → RunEvent | null` (null for Phase 0 rows / unknown types), `DaemonEventInput`/`DaemonEventBatch` (≤500), WS frames `RunLogClientFrame`/`RunLogServerFrame`, `ProjectNotice`. Caps: `TOOL_OUTPUT_MAX` 16 KiB, `DIFF_PATCH_MAX` 1 MiB.
- `packages/contract/src/lifecycle.ts`: `runTransitions`, `transitionActor`, `TERMINAL_RUN_STATES` (merged, abandoned), `ENDED_RUN_STATES`.
- RunEvent types (envelope `{seq, type, payload, at, emittedAt?}`):
  `run.started` (Run) · `run.claimed` ({machineId, run}) · `run.state` ({from, to, run}) · `agent` (AgentEvent; ONE type, the AgentEvent's own `type` discriminates) · `diff.snapshot` ({turn, base, patch, stats:{files, additions, deletions}, truncated?}) · `user.message` ({id: msg_…, text, author:{userId}}) · `run.cancel_requested` ({by}) · `pr.opened` ({url, run}). Only `agent` and `diff.snapshot` can be written by a daemon; the rest are written by core.
- Run schema now: `+ failed` state, `prompt` (required non-empty trimmed on `run.start`; legacy rows `''`), `openPr` (default true), `claimedBy`, `claimedAt`, `sessionId`, `prUrl`, `costUsd` (cumulative), `endedAt` — all nullable. Errors: `+ forbidden` (403), `conflict` (409).
- Core: `src/run-lifecycle.ts` (handlers + `authorizeWriter`), `src/rows.ts` (`toRun`), `src/memory-events.ts` (`createMemoryEvents()`: in-memory EventsPort with RunLog semantics — use it in daemon tests). `EventsPort` is now `{ append(runId, events[]) → StoredRunEvent[]; list(runId, since, limit); notifyProject(projectId, notice) }` (was `appendRunEvent`).
- DB: `0003_run_lifecycle.sql` = 8 plain `ALTER TABLE runs ADD` (drizzle generated no rebuild; `DEFAULT true` hand-changed to `1`). Verified on local state: 11 tasks/11 runs survived. Old RunLog DOs get `emitted_at`/`key` columns added in place (constructor checks `pragma_table_info`; verified live on a Phase 0 run).

**Commands** (all `POST /v1/commands/<name>`; REST paths are metadata except where noted)
| command | input | output | notes |
|---|---|---|---|
| `run.start` | {taskId, agent, location='local', **prompt**, openPr=true} | Run | appends `run.started`; local runs → ProjectRoom `run.queued` |
| `run.claim` | {id, machineId} | Run | owner only; `UPDATE … WHERE id AND state='queued' AND location='local' RETURNING`; loser → 409; same machine re-claim of its running run is idempotent; cloud → 409. Emits `run.claimed` + `run.state`, notice `run.state` |
| `run.update` | {id, machineId?, state?, sessionId?, costUsd?, prUrl?, endedAt?} | Run | owner only; a given machineId must equal claimedBy (else 403); sessionId/costUsd/prUrl/endedAt need the claimer; transition must be in the table (else 409) and `claimer` transitions need the claimer (else 403). Optimistic `WHERE state=<from>` (409 on race). Entering review/failed/abandoned/merged stamps endedAt; → running clears it. Emits `run.state` (+ notice) and `pr.opened` when prUrl changes |
| `run.message` | {id, text} | {event: StoredRunEvent} | owner only, any surface; 409 on terminal; appends `user.message`, notice `run.message` |
| `run.cancel` | {id} | Run | owner only; `running` → appends `run.cancel_requested` (+ notice), state unchanged, **daemon finalizes** with `run.update state=abandoned`; any other live state → abandoned immediately; terminal → 409 |
| `run.events` | {id, since=0, limit=500 (≤1000)} | {events: StoredRunEvent[]} | any signed-in user. Also `GET /v1/runs/:id/events?since=&limit=` without an upgrade header |
| `run.append` | {id, machineId, events: DaemonEventInput[1..500]} | {seqs} | HTTP fallback, also served at **`POST /v1/runs/:id/events`** (body `{machineId, events}`; machineId may come from `x-sf-machine`). Claimer of the owner only, run not terminal |

Authorization decision: reads open to any signed-in user (no project ACLs yet); every mutation of an existing run is owner-only (`ctx.userId === run.startedBy`); daemon effects also need `machineId === run.claimedBy`. Machine ids are self-chosen by the daemon (`MachineId` = `[\w.:-]{1,128}`, no registry, no `machine.*` commands) — they separate one owner's machines, the owner check is the security boundary. Stage 10: generate `mch_<uuid>` once and keep it in the CLI config.

**Transition table** (`runTransitions`; `claimer` = owner's claiming daemon, `owner` = owner from any surface; claimer can do owner ones too; `queued → running` only via `run.claim`)
- queued → abandoned (owner)
- running → blocked | review | failed (claimer), abandoned (owner — escape hatch for a dead daemon)
- blocked → running | failed (claimer), abandoned (owner)
- review → running (claimer, follow-up resumes), merged | abandoned (owner)
- failed → running (claimer), abandoned (owner)
- checks, final_review: no transitions yet (Phase 4); merged, abandoned: terminal

**WS protocol for the daemon**
- Auth = same as CLI: `Authorization: Bearer <token>` (or loopback dev bypass), **no Origin header** (cookies are stripped when Origin is absent; CSWSH guard unchanged). The Worker strips every client `x-sf-*` header and sets `x-sf-role`/`x-sf-user`/`x-sf-machine` for the DO.
- Project room: `GET /v1/projects/:projectId/room` + header `x-sf-machine: <id>` (→ tagged `daemon`; without it `viewer`). Server → client only: `ProjectNotice` JSON frames `{type:'run.queued', run}`, `{type:'run.state', from, to, run}`, `{type:'run.message', runId, message}`, `{type:'run.cancel_requested', runId, by}`. Broadcast goes to every socket in the room; the daemon filters (`run.location==='local' && run.startedBy===me`) then calls `run.claim`. No replay: on (re)connect, the daemon must catch up with `run.list` and claim queued local runs itself.
- Run log writer: `GET /v1/runs/:runId/events?since=<lastSeq>` + `x-sf-machine: <id>` (must be the claimer, else **403 JSON before upgrade**; no machine header = viewer). Server → client: every `StoredRunEvent` (replay seq > since, then live) — the daemon sees `user.message` and `run.cancel_requested` here (and `run.state` etc.); the writer's OWN appended frames are not echoed back to it (but events it appends via HTTP fallback are). Client → server: `{"type":"append","events":[{type:'agent'|'diff.snapshot', payload, emittedAt?, key?}, …]}` → reply `{"type":"ack","seqs":[…]}` in input order, or `{"type":"error","code":"invalid_input"|"forbidden","message"}`. A repeated `key` returns the original seq and is not re-broadcast (use `<machineId>:<counter>` and resend unacked frames after reconnect). Text `ping` → `pong` via `setWebSocketAutoResponse` on both DOs (no wake).
- RunLog RPC: `append(event)`, `appendMany(events)`, `list(since=0, limit=-1)`, `connections()`; ProjectRoom RPC: `broadcast(notice, role?)`, `connections()`.

**Web/CLI/gate changes**: Start run dialog has a required Prompt textarea; `sf run start … --prompt <text>` (required); `cli.runStart(task, agent, location, prompt)` → `sf run start --task T --agent A --location L --prompt P`; `sf run get` shows prompt/machine/pr; `failed` badge; `applyRunEvent`/`sf watch` read the run from `payload.run` too. `scripts/gate.sh` passes `--prompt` and now also asserts `run.claim` twice → 200 then 409. `apps/api/scripts/smoke.sh` sends a prompt.

**Tests**: contract 9, core 26 (incl. claim race via `Promise.allSettled`, full from×to transition matrix, legacy row defaults), api 19 (claim 409, writer 403, WS append+ack+fanout+no-echo+dedupe+replay, viewer read-only, follow-up + cancel on the daemon socket, HTTP batch + JSON list, ProjectRoom `run.queued`/`run.state` on start/claim), cli 22, web 5. `pnpm check && pnpm typecheck && pnpm test && pnpm build && pnpm gate` pass.

**Gotchas for stages 9–11**
- Writer authorization is checked at WS connect only. A writer socket stays writable after the run goes terminal (HTTP `run.append` re-checks every time). Fine for one daemon per machine. Close the socket when the run ends.
- `run.cancel` on `running` does NOT change state; stage 10 must stop the agent then `run.update {state:'abandoned', machineId}`. Owner can force-abandon a running run with `run.update` (no machineId); the daemon should treat a `run.state → abandoned` notice/event as cancel.
- Follow-ups on a `review`/`failed` run: the daemon learns via the ProjectRoom `run.message` notice (it may have closed the run's socket); it should `run.update state=running` (clears endedAt) before resuming the session.
- `costUsd` on Run is cumulative (set by the daemon); `AgentUsage.costUsd` in `turn.completed` is the per-turn delta.
- Web (stage 11): use `parseRunEvent` for typed rendering; Phase 0 `run.started` payloads lack the new Run fields and parse to null — render them raw. The ProjectRoom is also usable by the GUI (viewer) for live "Needs you".
- Local dev caveat still applies: DO sockets are per process; point daemon + browser at the same server (5173).
- `run.events` REST GET shares its path with the WS upgrade route; the upgrade header decides.

### Stage 9: adapters (2026-10-17)

**Package** `packages/adapters` (`@sf/adapters`): deps `@anthropic-ai/claude-agent-sdk@0.3.302`, `@openai/codex-sdk@0.163.0`, `@sf/contract`, `zod`; devDeps `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` (types only), `tsx` (smoke script). Scripts: `typecheck`, `test` (32 tests, no tokens), `smoke`.
Exports (TS source, like the other internal packages): `@sf/adapters` (types, `loadAdapter`, `startAgent`, `isAdapterName`, `buildAgentEnv`, `API_KEY_VARS`, `findOnPath`, `resolveBinary`; imports NO SDK), `@sf/adapters/claude-code`, `@sf/adapters/codex`, `@sf/adapters/fake`. Each adapter module imports its SDK only inside `start()` (`await import(...)`); `loadAdapter` uses `import('./<name>/index')`, so a bundler splits each adapter into a lazy chunk. Verified with `vp pack --deps.never-bundle @anthropic-ai/claude-agent-sdk --deps.never-bundle @openai/codex-sdk`: the output kept `import("@anthropic-ai/claude-agent-sdk")` / `import("@openai/codex-sdk")` external, with one small chunk per adapter.

**Interface** (`src/types.ts`)
```ts
type AdapterName = 'claude-code' | 'codex' | 'fake';
type BinaryChoice = 'auto' | 'bundled' | string /* absolute path */;
interface StartAgentOptions { cwd; prompt; resumeSessionId?; signal?: AbortSignal;
  env?: Record<string,string|undefined> /* base, default process.env */; extraEnv?; allowApiKeys? /* default false */;
  model?; binary?: BinaryChoice /* default 'auto' */; additionalDirectories?; onStderr? }
interface AgentSession { agent; events: AsyncIterable<AgentEvent> /* single consumer, ends when the session ends */;
  sessionId: string|null; idle: boolean /* no turn running, nothing queued */;
  send(text): void /* throws once closed */; end(): void /* finish queued work, then stop */; cancel(): void /* stop now */;
  result: Promise<AgentResult> /* never rejects */ }
interface AgentResult { ok; cancelled; sessionId; costUsd? /* sum of per-turn deltas; undefined for codex */;
  usage: { inputTokens /* incl. cached */, outputTokens, cachedInputTokens }; turns; error? }
interface AgentAdapter { name; start(o: StartAgentOptions): Promise<AgentSession> }
loadAdapter(name: string): Promise<AgentAdapter>          // throws for 'opencode'/unknown
startAgent({ agent, ...StartAgentOptions, ...adapterSpecific }): Promise<AgentSession>
```
A session does NOT end when a turn finishes. It waits for `send()` until `end()` or `cancel()`. `idle` is already updated when the consumer receives `turn.completed`, so `if (ev.type === 'turn.completed' && s.idle)` is reliable. A thrown SDK error (claude) or a fatal `error` event ends the session with `ok:false, error`. A failed codex/fake turn is non-fatal: you get `error{fatal:false}` + `turn.completed{isError:true}`, the session stays usable, and `ok` reflects the LAST turn.

**Per-adapter semantics**
| | claude-code | codex | fake |
|---|---|---|---|
| process | one long-lived CLI process per session (streaming input; `prompt` = async iterable inbox) | a new `codex exec --experimental-json [resume id]` per turn | in-process |
| follow-up `send` | pushed into the live session at once. **Verified live: a message sent mid-turn (no `priority`) was folded into the running turn between tool calls**, so one `result` covered both (`user_message_uuids` had 2 entries) | queued; runs as the next turn on the same thread once the current one finishes; several queued messages are joined with `\n\n` | same as codex |
| idle tracking | each sent message gets a uuid; `result.user_message_uuids` clears them | queue empty + no turn running | same |
| cancel | `abortController.abort()` + close the inbox + `q.close()` | aborts the turn's `AbortController` (SIGTERM to the child), drops the queue | aborts sleeps, nothing more is written |
| resume | `options.resume = id` (same session id comes back) | `codex.resumeThread(id, threadOpts)` (same thread id) | reuses `resumeSessionId` as the session id |
| cost | `total_cost_usd` is cumulative → per-turn delta. **On resume the total continues from the transcript (verified)** → pass `costBaseUsd` (the session's earlier total) or the first delta re-counts it | none (ChatGPT plan) | `costUsd` per scripted turn (default 0.01) |
| usage | `result.usage` is per turn (main loop). inputTokens = input + cache_creation + cache_read | **`turn.completed.usage` is CUMULATIVE for the thread, and continues across resume (verified live: output 63 → 126 → 131)** → the mapper emits deltas; pass `usageBase` on resume | per turn |
| permissions | `permissionMode:'acceptEdits'` + `canUseTool` = `createPathGuard([cwd, ...additionalDirectories])` (allows any tool, denies `file_path`/`notebook_path`/`path`/`blockedPath` outside the roots) + `settingSources:['project','local']` | `sandboxMode:'workspace-write'`, `approvalPolicy:'never'`, `skipGitRepoCheck:true` | writes only inside cwd (escape → failed turn) |
| env | `buildAgentEnv` (full base env minus `ANTHROPIC_API_KEY`/`CODEX_API_KEY`/`OPENAI_API_KEY` unless `allowApiKeys`) + `CLAUDE_AGENT_SDK_CLIENT_APP=sf` | same (passed as `CodexOptions.env`) | reads `SF_FAKE_SCRIPT` from it |
| binary | `binary:'auto'` = `claude` on PATH → `pathToClaudeCodeExecutable`, else the bundled one | `codex` on PATH → `codexPathOverride` | – |
| extra options | `costBaseUsd`, `permissionMode`, `settingSources`, `disallowedTools`, `maxTurns`, `maxBudgetUsd` (`ClaudeCodeStartOptions`) | `sandboxMode`, `networkAccessEnabled`, `modelReasoningEffort`, `usageBase` (`CodexStartOptions`) | `fakeScript` (`FakeStartOptions`) |

Mapping follows research §3. Claude skips subagent traffic (`parent_tool_use_id`), replays, and all other message kinds. `file.change` comes from successful Write (`add`) / Edit / MultiEdit / NotebookEdit (`update`) tool results, with the path ABSOLUTE as given to the tool. `TodoWrite` → `tool.call` + `todo`. Empty thinking blocks are dropped (Opus 5.5 returns empty thinking by default). Codex emits `file.change` only for `file_change` items. In the smoke run it wrote files with `printf` in `shell`, so no `file.change` appeared. **Use `diff.snapshot` as the source of truth for changes.** Tool output is capped to `TOOL_OUTPUT_MAX` (`truncated: true`).

**Fake script** (`src/fake/script.ts`, zod `FakeScript`): `{ sessionId?, stepDelayMs=0, turns?: FakeTurn[], followUp?: FakeTurn }`, `FakeTurn = { steps, costUsd=0.01, result? }`. Steps are `message | reasoning | write{path,content} | tool{name,input?,output?,isError?} | todo{items} | sleep{ms} | burst{count,intervalMs,text}` (for latency) `| error{message,fatal}` (fatal ends the session) `| fail{message}` (failed turn). Templates: `{{prompt}} {{turn}} {{i}}`. Source order: `fakeScript` option > `SF_FAKE_SCRIPT` env (inline JSON or a path to a .json file) > `defaultFakeScript`. The default writes `sf-fake-turn-<n>.md` (`# Turn n\n\n<prompt>\n`) on every turn, so turn 1 and each follow-up produce a diff. Messages: "Working on: …" / "Follow-up received: …" / "Done with turn n.". Session id `fake-<uuid>`.

**Smoke runs** (`pnpm --filter @sf/adapters smoke <claude-code|codex> <scratch-dir> [--record]`, script `packages/adapters/scripts/smoke.ts`). Each run makes a throwaway git repo, prompts "create hello.txt containing hi", sends "also create bye.txt" on the first `tool.call`, calls `end()` when idle, then resumes the session for "reply ok". `--record` writes redacted raw SDK messages to `packages/adapters/fixtures/<agent>/smoke.jsonl`. Redaction maps home → `~`, the user name → `user`, drops rate-limit events and mcp/plugin/skill inventories, and blanks account/org keys. `src/recorded.test.ts` replays both fixtures through the mappers.
- claude-code: PASS (about 10 s, about $0.19 estimated on the Max plan). init `apiKeySource: 'none'` (the subscription login was used, with ANTHROPIC_API_KEY stripped). Both files were created. Resume returned the same session id with `total_cost_usd` 0.1830 → 0.1946.
- codex: PASS (about 20 s). The ChatGPT login was used (`codex login status` → "Logged in using ChatGPT"; no API key). The follow-up ran as turn 2 on the same thread, and resume kept the thread id `01a14c1c-…`.
- **Research UNVERIFIED items:**
  1. One `result` per turn in streaming mode: the `.d.ts` says so ("exactly one result message per turn"). Live, the folded turn produced exactly one result. Two separate turns inside one query were not exercised live.
  2. `total_cost_usd` is cumulative per query() call (running total). This is confirmed by the `.d.ts` and live, including that it continues across resume.
  3. `priority`: the `.d.ts` does not document what it means. With the default (no priority), a mid-turn message folds into the running turn. The adapter never sets `priority`.
  4. Codex login path: CONFIRMED.

**Gotchas for stage 10 (daemon)**
- Bundling: the CLI's tsdown config must bundle `@sf/adapters` (workspace TS source, like `@sf/contract`) and mark `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` never-bundle. Add both SDKs as real `dependencies` of `@sf/cli` so they resolve at runtime. Only import `@sf/adapters` (or call `loadAdapter`) from the lazy `sf daemon` subcommand. Note that `deps.onlyBundle: ['citty','zod']` in `apps/cli/vite.config.ts` probably needs `@sf/*` or an explicit `neverBundle` list.
- The contract `Agent` enum is `claude-code | codex | opencode` and has **no `fake`**. Stage 10/12 must add `fake` (maybe dev-only) for the gate, or map it. `loadAdapter('opencode')` throws, so fail the run with a clear error.
- Map events → RunLog as `{ type: 'agent', payload: ev, emittedAt: Date.now(), key }`. After each `turn.completed`, append a `diff.snapshot`, and set `run.update { costUsd: run.costUsd + ev.usage.costUsd, sessionId }` once `session.started` arrives.
- Follow-up to a live session: call `session.send(text)`. For a `review` run whose session ended: `run.update state=running`, then `startAgent({ resumeSessionId: run.sessionId, prompt: text, costBaseUsd /* claude: previous total for that session */ })`. Codex token deltas on resume need `usageBase` (optional, display only).
- Cancel: `run.cancel_requested` or a `run.state → abandoned` → `session.cancel()`, `await session.result`, then `run.update state=abandoned`.
- Run end: when `turn.completed && session.idle` → decide `review` (`ok`) or `failed`. Keep the session warm for follow-ups, or `end()` it and resume later. Claude keeps a CLI process alive while idle; Codex/fake hold nothing between turns.
- Claude `file.change` paths are absolute and Codex paths are as reported. Relativize to the worktree if needed.
- `binary:'auto'` follows whatever `claude`/`codex` is on PATH (here both are mise installs, 2.1.302 / 0.163.0, matching the SDKs). If they drift, use `binary:'bundled'`.
- Claude `settingSources: ['project','local']` ignores the user's global settings and permission rules on purpose.
- Smoke repos are left in the scratch dir. Tests never spawn an agent.

### Stage 10: daemon + local loop CLI (2026-10-17)

**What exists (all in `apps/cli/src` unless noted)**
- `git.ts`: execFile git helpers (research §5): `mainRepoRoot` (via `--git-common-dir`, so it works from inside a task worktree), `currentBranch`, `remoteUrl`, `normalizeRepoUrl` (scp/ssh/https → `host/owner/repo`, lowercased), `isGitHubUrl`, `defaultBranch` (origin/HEAD → main/master → current), `listWorktrees`, `withRepoLock` (per-repo promise chain), `ensureWorktree({repo, path, branch})` → `{path, branch, baseBranch, baseSha = merge-base(baseBranch, HEAD), created}` (reuse if listed; else `worktree add [-b]`; refuses a non-worktree dir in the way), `diffAgainst(cwd, base, max)` (temp `GIT_INDEX_FILE`, incl. untracked, honours .gitignore, `--src-prefix=a/ --dst-prefix=b/` because user configs like `diff.mnemonicPrefix` change prefixes; numstat → stats; over max → `patch:''`, `truncated`), `commitAll` (skips when clean; user's identity, falls back to `sf <sf@localhost>` only if none; `--no-verify`), `aheadCount`.
- `context.ts`: `findLink(cwd, config)`, `chooseProject` (for `sf link`), `resolveRunTarget` (for `sf run start`), `ContextError` with actionable messages.
- `pr.ts`: `PrProvider { name; open({cwd, branch, base, title, body}) → {url} | null }`. `ghPrProvider` (null unless origin is GitHub; `git push -u origin <branch>`, reuse `gh pr view <branch>`, else `GH_PROMPT_DISABLED=1 gh pr create --draft --head --base --title --body-file -`), `createFakePrProvider()` (never pushes; URL `https://github.com/<owner>/<repo>/pull/<n>` from a GitHub origin, else `github.com/sf-fake/<dir>`; one URL per cwd+branch; `.opened` list), `nonePrProvider`, `selectPrProvider(name)`.
- `daemon/socket.ts`: `WebSocketLike`, `DaemonTransport { client; connect(path) }`, `nodeTransport` (Node WebSocket + `authorization` + `x-sf-machine`, no Origin), `ManagedSocket` (backoff 0.5 s→30 s with jitter, reset after 10 s stable; `ping` every 25 s, no `pong` in 10 s → reconnect; `open()` re-run per connect so `?since=` is current).
- `daemon/writer.ts` `RunLogWriter`: buffers, flushes on `setImmediate` as `append` frames (≤500 events, ≤512 KiB; a bigger single event — e.g. a ~1 MiB diff — goes over HTTP), acks are FIFO per frame (an `error` frame drops the oldest in-flight frame and logs). Keys `<machineId>:<8-char nonce>:<n>`. On close, unacked frames are re-queued; while the socket is down batches go to `run.append` (HTTP); 2 s grace on the very first connect before falling back. `flush()`, `close()` (flush ≤10 s then stop the socket — this closes the writer when the run ends). Incoming non-ack frames = StoredRunEvents → `onEvent`, `lastSeq` tracked from them (not from acks).
- `daemon/worker.ts` `RunWorker` (one claimed run): `mode 'new' | 'resume'`; `run.update running` (resume only) → `ensureWorktree` at `worktreePath(dataDir, projectId, taskId)` → `run.events` history (all pages) → turns so far = #diff.snapshot; unhandled follow-ups = `user.message` with seq after the last `run.state → review|failed` → writer socket `?since=<last seq>` → `startAgent({agent, cwd: worktree, prompt, env: agentEnv ?? process.env, resumeSessionId?, costBaseUsd?, onStderr})` → forwards every AgentEvent as `{type:'agent', payload, emittedAt: Date.now()}`; `session.started` → `run.update sessionId`; each `turn.completed` → `diff.snapshot` (turn numbering continues across sessions) + `run.update costUsd` (cumulative: run.costUsd + deltas) and `session.end()` when `idle` with nothing pending. Follow-ups (socket `user.message`, room `run.message`, deduped by message id) → `session.send`; if the session is already ending they queue and the worker resumes the same session for them before wrapping up. Cancel = socket/room `run.cancel_requested` or `run.state → abandoned` → `session.cancel()`.
  - New run on a task: resumes the latest earlier run's session **of the same agent** (`run.list {taskId}`); `costBaseUsd` = sum of `costUsd` of every run on the task with that sessionId (Claude's total continues across resume). Codex `usageBase` is NOT passed (Run has no token totals; display-only).
  - Wrap-up: user cancel → `abandoned` (no commit, worktree left dirty); daemon shutdown → commit + agent `error{fatal}` "sf daemon stopped" + `failed`; agent not ok → commit + `failed`; ok → commit (`<task title>\n\nsf run <id>`) → if `openPr` and the branch is ahead of base → `prProvider.open` (errors become a non-fatal agent `error` event) → one `run.update {state:'review', prUrl?, costUsd}` (core emits `run.state` then `pr.opened`). A user cancel that races the wrap-up still wins (`abandoned`). Fatal setup errors (worktree, unknown adapter e.g. `opencode`) → agent `error{fatal}` + `failed`.
- `daemon/daemon.ts` `Daemon`: one `ManagedSocket` per linked project room; every room (re)connect and every finished run → `scan()` (serialized: `task.list` per linked project + `run.list {}` → claims queued local runs of linked projects oldest-first). First scan also fails runs left `running` by this machine id (crash/kill -9). Limits: `maxConcurrency` (default 2, counts claims in flight) and one run per task. `run.claim` 409 → `stats.conflicts++`, logged "already claimed elsewhere (409)", moves on; 403 → the run is skipped for the daemon's lifetime (another user's run when no userId is known). Room notices: `run.queued` → claim; `run.cancel_requested` / `run.state→abandoned` → cancel worker; `run.message` for a run with no worker → `tryResume` (run.get; only if `claimedBy === me` and state review/failed; waits for a slot). `stop()` cancels all workers (`'shutdown'`), waits ≤15 s. `idle()` for tests.
- `daemon/testing.ts` (test-only, not bundled): `createHub(userId)` = core `dispatch` on libsql + memory events with RunLog/ProjectRoom semantics over `FakeSocket`s (writer auth via `authorizeWriter`, replay `?since`, no echo to the writer, acks, room fan-out), `hub.dropAll()`, `hub.offline`, `hub.stats {wsFrames, httpAppends}`.
- Commands: `commands/daemon.ts` (pid lock `<configdir>/daemon.pid`; `ensureMachineId()`; lazy-imports daemon/socket/pr/client/`@sf/adapters` inside `run`), `commands/link.ts` (`link`, `unlink`), `commands/open.ts`; `commands/run.ts` gains `message`, `cancel`, `--title`, `--no-pr`, agent `fake`; `watch.ts` `describeEvent` renders every event type.
- Contract: `Agent` = `claude-code | codex | opencode | fake`. DB: `runs.agent` enum gets `fake` (TS-only: drizzle-kit says "No schema changes", no migration). Web: `apps/web/src/lib/agents.ts` `agentsFor(hostname)` — the Start-run dialog adds `fake` only when `window.location.hostname` is loopback (localhost/127.0.0.1/[::1]); server side stays permissive (core accepts `fake` from any surface).

**Commands**
| command | notes |
|---|---|
| `sf link [--project ID]` | in a git repo; links the MAIN repo root (works from a worktree). No `--project`: `origin` remote vs `project.repoUrl` (normalized); 0 / >1 matches / no remote → clear error |
| `sf link --list`, `sf unlink` | |
| `sf daemon [--max-concurrency N] [--pr-provider gh\|fake\|none]` | foreground, logs to stderr; ctrl-c/SIGTERM = graceful (runs → failed), twice = force exit |
| `sf run start --agent A --prompt P [--task ID \| --title T] [--location L] [--no-pr]` | no `--task`: linked repo + `--title` creates the task, else the task whose `branch` = current branch (so from inside a task worktree it just works). Explicit form unchanged = web copy-as-CLI (`cli.ts` untouched; `--no-pr` is CLI-only) |
| `sf run message RUN_ID "text"`, `sf run cancel RUN_ID` | |
| `sf watch RUN_ID` | readable lines: `assistant`, `tool → Name input` / `tool ← ok …`, `files`, `todo`, `turn done $x in/out`, `diff turn n: f file(s) +a -d`, `you`, `state from → to`, `claimed`, `cancel`, `pr <url>` |
| `sf open [RUN_ID]` | `/runs/<id>`, else current branch's task, else linked project, else `/`; xdg-open (`open` on macOS), prints the URL if it can't. Base = `SF_WEB_URL` or the API URL. `SF_NO_BROWSER=1` = print only |

**Config** (`~/.config/sf/config.json`, `SF_CONFIG_DIR` overrides):
```json
{ "token": "…", "apiUrl": "…", "user": {"id": "…"},
  "machineId": "mch_<32 hex>",
  "links": { "/abs/main/repo/root": { "projectId": "prj_…", "linkedAt": "ISO" } },
  "daemon": { "maxConcurrency": 2, "prProvider": "gh" } }
```
Data dir (worktrees): `SF_DATA_DIR` > `$XDG_DATA_HOME/sf` > `~/.local/share/sf` → `worktrees/<projectId>/<taskId>`.
**PR provider selection**: `--pr-provider` > env `SF_PR_PROVIDER` > `daemon.prProvider` > `gh`. Use `fake` for the gate. Fake agent script: env `SF_FAKE_SCRIPT` (JSON or path) on the DAEMON process (agents get the daemon's env).

**Bundle**: SDKs are real `dependencies` of `@sf/cli` + `deps.neverBundle` (dist keeps `import("@anthropic-ai/claude-agent-sdk")` / `import("@openai/codex-sdk")` in the adapter chunks); `@sf/adapters`, `@sf/contract` are bundled. Gotcha: citty's `sf --help` resolves EVERY subcommand to print descriptions, so command modules must keep heavy imports inside `run()` (daemon.ts does) — cold start 41–43 ms (was ~41 at baseline on this machine).

**Tests** (cli 44, no tokens, no network): `git.test.ts` (worktree create/reuse/existing branch/dir in the way, diff incl. untracked without index side effects, truncation, commit, lock, fake PR), `context.test.ts` (link matching + errors, run target: --task, branch, from a worktree, --title, errors), `daemon/daemon.test.ts` against `createHub`: claim → events → diff ×2 → mid-run follow-up → commit → fake PR → review (WS only); follow-up after review resumes the same session; cancel → abandoned; two daemons → one 409; shutdown → failed + stale-running recovery; socket drop → HTTP fallback, every event exactly once in order. Web +1 (`agentsFor`).

**Manual loop (verified on pnpm dev, 5173)** — exact commands:
```sh
pnpm db:migrate:local && pnpm build            # or just: pnpm --filter @sf/cli build
setsid pnpm dev > /tmp/dev.log 2>&1 &           # http://localhost:5173 (dev auth bypass, no login needed)
export SF_CONFIG_DIR=$PWD/.scratch/config SF_DATA_DIR=$PWD/.scratch/data   # isolate from ~/.config
SF="node $REPO/apps/cli/dist/cli.mjs"
mkdir r && cd r && git init -b main && echo hi > README.md && git add -A && git commit -m init
git remote add origin git@github.com:acme/sf-manual.git
$SF project create --name manual --repo https://github.com/acme/sf-manual
$SF link
SF_FAKE_SCRIPT=/path/script.json $SF daemon --pr-provider fake &      # script optional (default fake script)
$SF run start --title "Manual loop test" --agent fake --prompt "create hello.md"   # prints run id
$SF watch <run>   # in another shell;   $SF run message <run> "also add followup.md"
git log sf/manual-loop-test -1                  # "Manual loop test\n\nsf run <run>"
```
Observed: claim → session → message/tool/files → follow-up mid-turn → turn 1 diff → follow-up turn → turn 2 diff → review → `pr https://github.com/acme/sf-manual/pull/1`; commit on the task branch, main checkout untouched; a second `sf run start` from inside the worktree resolved the task by branch and resumed the fake session; `sf run cancel` → abandoned in ~30 ms; SIGINT → run `failed`, work committed, daemon exits, pid file removed. **One real claude-code run** (no PR, "create hi.txt containing hi"): PASS in ~6 s, $0.081, model claude-opus-5-5, committed `hi.txt` — confirms the externalized SDK resolves from `apps/cli/dist`. Everything started was stopped. `pnpm check && pnpm typecheck && pnpm test && pnpm build && pnpm perf && pnpm gate` pass.

**Gotchas for stages 11–12**
- `pnpm gate:local` (stage 12): run the daemon with `--pr-provider fake` (or `SF_PR_PROVIDER=fake`), isolated `SF_CONFIG_DIR`/`SF_DATA_DIR`, and a repo whose origin is a GitHub URL matching the project's `repoUrl` (or use `sf link --project`). Wait for the room to connect (log line `room … connected`) before `run start`, or rely on the catch-up scan (it handles either order). Kill the daemon with SIGTERM and wait for "stopped".
- The existing `pnpm gate` claims runs with `mch_gate_a`; a daemon linked to the gate's project would race it — don't run a daemon during `pnpm gate`.
- Daemon scans use `run.list {}` (ALL runs, no filter) + `task.list` per linked project on every room connect / run end. Fine locally; add a `run.list {state, location}` filter if it gets slow.
- No token (dev bypass): the daemon doesn't know its user id, so it tries to claim any queued local run in linked projects and skips ones that 403. With `sf login` it filters by `config.user.id`.
- Diff `emittedAt` is stamped on every daemon event (Date.now() right before queueing, not right before `ws.send`; the flush is the next `setImmediate`, so it's within ~1 ms). For the latency gate use the fake `burst` step.
- Follow-ups on a `review` run that was claimed by a daemon that is NOT running are not picked up when that daemon restarts (no catch-up for review runs with unhandled messages; only the live room notice triggers resume). Stage 11 UI should show such messages as "waiting for the daemon".
- Fake adapter on resume restarts its turn counter at 1 (it uses `turns[0]` again), so a resumed fake session repeats the first-turn script; daemon-side `diff.snapshot.turn` keeps counting.
- Cancelled runs leave uncommitted changes in the task worktree (the next run on the task reuses it, dirty). Worktrees are never removed yet (`removeWorktree` exists, unused).
- `run.update` without a state change but with sessionId/costUsd emits no event; the web learns cost from `turn.completed.usage.costUsd` or by re-fetching the run.
- Web run view (stage 11) gets claude `file.change` paths absolute (worktree path); render the diff.snapshot instead.

### Security fix: Claude adapter Bash sandbox (orchestrator, 2026-10-17)
- An automated review flagged `createPathGuard` approving every Bash command, which no OS layer contained, so a shell command could write outside the worktree.
- `claudeOptions` now passes `sandbox: defaultSandbox` = `{ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }` (overridable via `ClaudeCodeStartOptions.sandbox`). `failIfUnavailable` stays at its default of true, so a missing bubblewrap fails the run instead of running unsandboxed. Linux needs `bwrap` + `socat`, both present here.
- The path guard now resolves symlinks through the nearest existing ancestor before its inside-the-roots check (test: a symlink inside the worktree that points outside is denied).
- Verified with a real run: `echo hi > inside.txt` succeeds; `echo … > /home/ryan/code/x` fails with "Read-only file system". Writes to the Claude temp dir (`/tmp/claude-<uid>/…`) are allowed by the sandbox on purpose.
- Network is not restricted (agents need package registries). Revisit an egress allowlist with cloud runs (Phase 3).

### Stage 11: web live run view (2026-10-17)

**Routes**
- `/runs/$runId` (`routes/runs/$runId.tsx`): header = run id + state badge + socket status, task title link, actions `sf watch <id>` copy box + **Cancel** (queued/running/blocked; AlertDialog confirm always, since abandoning is irreversible; dialog shows `sf run cancel <id>`). Facts row: agent (+model), location, machine (`claimedBy`), cost, elapsed (ticks while live, client-only after hydration), branch (from the cached `task.list`; still no `task.get`), PR link / "when the run ends" / "off". Body = transcript (`h-[60svh]`), then the follow-up box (InputGroup textarea, Ctrl/⌘+Enter, `run.message` via `commandFn`; the returned event is merged immediately; disabled with a reason on merged/abandoned or cloud runs) + `sf run message <id> '<text>'` copy box. Keys: `c` cancel (confirm), `/` focus follow-up, Esc blurs it.
- `/` Needs you: review → failed → blocked → queued (newest first), columns Run / Prompt / State / Why (short reason + PR link) / Agent / Cost / Task / Created. `/tasks/$taskId`: newest first, Prompt (truncated, full text in `title`), State, Agent, Cost.
- Start-run dialog (`components/dialogs.tsx`): prompt textarea first (Ctrl/⌘+Enter submits), agent (fake only on loopback), location, **openPr checkbox** (default on), static Alert for local runs ("picked up by `sf daemon` … linked (`sf link`)") — there is no daemon-presence API, so it is always shown for local. Copy box adds `--no-pr` when unchecked. Dialog widened to `sm:max-w-lg`; forms got `min-w-0` (a long copy-cli string overflowed the grid dialog).

**Modules**
- `lib/transcript.ts` — the **view model**: `buildTranscript(events, runState) → { blocks, turns, costUsd, lastSeq, sessionId, model }`. Items: assistant (markdown) · reasoning · tool (call+result paired by id; `summary` = command/file_path/pattern/… relativized to `session.started.cwd`; status running/done/error; running tools settle at turn end or when the run isn't running) · files · todo · user (follow-up, `pending` until any later agent event) · error · turn (per-turn usage/cost) · diff (parsed `diff.snapshot`, `latest` flag) · state (skips queued→running; review→running shows "Resumed") · note (claimed, cancel requested) · pr · raw (Phase 0 / unknown). Consecutive reasoning/tool/files/todo rows are grouped into one `activity` block (one `Trace`). Also `mergeEvents` (dedupe by seq), `messageBlockedReason`, `canCancel`, `needsYouReason`, `formatCost/Tokens/Elapsed`, `toolSummary`.
- `lib/diff.ts` — `parseUnifiedDiff(patch) → DiffFile[]` (status added/deleted/modified/renamed, binary, +/-, hunks with old/new line numbers). `components/diff-view.tsx`: one Card per snapshot ("Changes after turn n", files +a -d vs base sha; latest open, older collapsed), collapsible per-file unified table. No highlighter. New tokens `--diff-add`/`--diff-del` (light+dark) in `packages/ui/src/styles/globals.css` → `text-diff-add`, `bg-diff-del/10`.
- `lib/markdown.ts` + `components/markdown.tsx` — tiny markdown subset (headings, lists, quotes, fences, hr, code/strong/em/links) → React elements; raw HTML stays text; links only http(s)/mailto.
- `components/transcript.tsx` — shadcn chat primitives: `MessageScroller` (autoScroll; **no scrollAnchor** — with the user turn as anchor it stopped following the log), `Message`/`Bubble` for prompt + follow-ups, `Trace`/`TraceCollapsible` for tool rows (collapsed; expand → Input/Output `<pre>`), `Marker` for turns/state/errors/PR.
- `lib/run-events.ts` — frames batched per animation frame then `applyRunEvents` (merge + patch `run.get` from any `run`-carrying payload + invalidate `run.list`); control frames ignored; sockets closed quietly while CONNECTING (no StrictMode console warning). `lib/project-room.ts` — `useProjectRooms(ids)`: viewer WS per `/v1/projects/:id/room`; `run.queued`/`run.state` notices patch `run.get` + invalidate `run.list`; reconnect also invalidates (no replay).
- `lib/queries.ts`: `useCancelRun`, `useSendMessage`; `NEEDS_YOU` = review, failed, blocked, queued.
- `lib/cli.ts`: `runStart(…, openPr)` (`--no-pr`), `runMessage`, `runCancel`, `watch`, `open`, `daemon`, `link(project?)` — flags checked against apps/cli.
- shadcn added (via `pnpm dlx shadcn@4.22.0 add …` from apps/web, answering **no** to the formatting-only `button.tsx` overwrite prompt — pipe `yes n |`, the CLI otherwise hangs without a TTY): message-scroller, message, bubble, marker, trace, collapsible, checkbox, alert, alert-dialog, spinner. New dep `@shadcn/react@0.3.1` (pinned) in `@sf/ui`. Skipped `code-block` (pulls `shiki`). The registry files import `cn` from the `cn` package like the existing ones.

**Live vs on-navigation**: run page = live (RunLog WS, replay `?since=`). Needs you + task page = live via ProjectRoom viewer sockets (home: every project from `project.list`; task page: the task's project once `task.list` is cached) plus loader fetch on navigation. Cost on the run page = max(`run.costUsd`, sum of `turn.completed.usage.costUsd` in the log) because `run.update costUsd` emits no event.

**Verified in headless chromium** (playwright-core in the scratch dir, `/usr/bin/chromium`; `pnpm dev` + `sf daemon --pr-provider fake` with a scripted fake agent in a temp repo with a GitHub-style origin): start run from the task page dialog (Ctrl+Enter) → run page goes live, reasoning/assistant markdown/todo/Write/Bash rows stream in → `/` focuses the follow-up, Ctrl+Enter sends mid-turn, bubble shows at once and flips from "waiting for the agent" → turn 1 diff, turn 2 diff (follow-up) → `review` + fake PR `https://github.com/acme/sf-live/pull/1` in facts + transcript + Needs you row. Transcript followed the bottom while streaming; after scrolling up, a CLI follow-up on the review run resumed the session (turn 3 diff arrived) without yanking the scroll. `c` → confirm → `abandoned` in ~30 ms, follow-up box disabled with reason. Zero console errors/warnings, no hydration warnings. Screens: `.handoff/screens/run-live.png` (light), `run-live-dark.png`, `run-live-needs-you-dark.png`, `run-live-task.png`, `run-live-start-dialog.png`, `run-live-cancel.png`. Everything started was stopped.

**Perf** (`pnpm perf`): web initial JS gzip 236.3 KiB (was 229.7; budget 287), total 264.3 KiB (was 238.1; budget 298), CLI 45–50 ms. The run page is its own route chunk (`_runId-*.js`, ~17.6 KiB gzip; Start auto code-splits route components), `@shadcn/react` scroller ~6.6 KiB gzip. No budget change.

**Tests**: web 23 (transcript reduction incl. tool pairing, follow-up pending, diff latest/truncated, legacy raw, dedupe; diff parser incl. new/deleted/renamed/binary/line numbers; markdown incl. HTML + `javascript:` safety; cli strings). `pnpm check && pnpm typecheck && pnpm test && pnpm build && pnpm perf && pnpm gate` pass (1 stock `use-mobile` lint warning).

**Gotchas for stage 12**
- Stable selectors for `gate:local` browser/HTML checks: `data-testid` = `ws-status`, `transcript`, `assistant`, `tool` (+`data-tool`), `user-message` (`data-pending` while undelivered), `turn` (`data-turn`), `diff-snapshot` (`data-turn`), `pr`, `run-pr`, `run-facts`, `follow-up`, `follow-up-hint`, `cancel-run`, `confirm-cancel`; runs tables have `data-run`/`data-state` per row; `StateBadge` has `data-state`.
- The transcript is client-only (events come from the socket), so SSR HTML of `/runs/:id` has header/facts but no transcript — an HTML-only gate must assert via `run.events`/`run.get`, or use a browser.
- For "agent event → GUI" latency: events carry `emittedAt`; the page applies frames on the next animation frame (rAF pauses in background tabs — measure in a visible/headless page). A `performance.now()` hook would need adding (none exists).
- The fake adapter repeats its first-turn script on resume (stage 10 note), so a review-run follow-up replays turn 1 steps (incl. sleeps).
- Old queued runs from earlier stages (no daemon linked) fill Needs you locally; harmless.

### Stage 12: Phase 1 gate + perf (2026-10-17)

**`pnpm gate:local`** = `scripts/gate-local.sh` (lifecycle) + `scripts/gate-local.mjs` (driver, playwright-core 1.63.0 root devDep) + `scripts/gate-local.fake.json` (fake agent script, set as `SF_FAKE_SCRIPT` on the daemon only).
- Refuses if port 5173 is in use (node `net.connect`) or no chromium (`SF_CHROMIUM` > `/usr/bin/chromium(-browser)` > `google-chrome(-stable)` > playwright's own download) — fails, never skips.
- Isolation: one `mktemp -d` holding `SF_STATE_DIR` (D1/DO state, migrated first), `SF_CONFIG_DIR`, `XDG_DATA_HOME` (worktrees), the repo and logs; `SF_DATA_DIR`/`SF_PR_PROVIDER` unset. Deleted on exit (`SF_GATE_KEEP=1` keeps it). dev, daemon and driver each run under `setsid`; the EXIT trap TERMs then KILLs every process group (verified: TERM mid-run → exit 130, nothing left on 5173, temp dir gone). On failure the dev/daemon log tails are printed.
- Flow: dev → temp repo (origin `git@github.com:sf-gate/local-<stamp>.git`, never pushed) → `sf project create` → `sf link` (origin match) → `sf daemon --pr-provider fake` (waits for `room … connected`) → driver: warm `/` → `sf run start --agent fake --title … --prompt …` from inside the repo → run page: `ws-status` live, assistant + Bash tool rows, `diff-snapshot[data-turn=1]` (asserted delivered after the socket went live), `run-pr`, state review → follow-up typed into the page's follow-up box + Ctrl+Enter → `user-message` bubble → `diff-snapshot[data-turn=2]` contains the follow-up → API: review again after the message, `prUrl` `https://github.com/sf-gate/…/pull/1`, `pr.opened` → git: `gate.md` in the task worktree, last commit body has `sf run <id>`, exactly 2 commits `main..branch`, main checkout clean → second run (`--title "Gate cancel …"`), wait for `session.started`, `sf run cancel` → `abandoned` (11–21 ms) → perf → no page errors / console errors.
- The browser follow-up goes to a `review` run, so it exercises resume (fake replays `turns[0]` with the follow-up as prompt).
- **`pnpm gate` is isolated too** (temp `SF_STATE_DIR`, port check, log deleted on success). `apps/web/vite.config.ts` `persistState.path` = `SF_STATE_DIR` || `apps/api/.wrangler/state`; `@sf/api db:migrate:local` passes `--persist-to "${SF_STATE_DIR:-.wrangler/state}"` (both append `v3/`; same D1 file name). Verified the dev DB has 0 `gate-local*` projects after the runs.
- **`pnpm db:reset:local`** = `rm -rf apps/api/.wrangler/state && pnpm db:migrate:local`. Added, NOT run — the dev sidebar still has the old `gate-*` / `Playwright Demo` projects until the user runs it (with `pnpm dev` stopped).
- CI: `pnpm gate:local` added after `pnpm gate` (ubuntu-latest ships google-chrome at `/usr/bin/google-chrome`). **Not verified on a runner** (no remote); if it fails there, first suspects are chrome sandboxing as root-less runner user (should be fine) and the latency budgets on a slow shared runner.

**Perf** (`perf-budget.json`, `source: "gate:local"`, `measured: true`, budget = plan target, baseline = worst p95 of the two final runs). gate:local enforces them and writes `.perf/gate-local.json` (gitignored); `pnpm perf` re-checks that file when present and prints a note otherwise.
| budget | how | run 1 p50 / p95 | run 2 p50 / p95 | target |
|---|---|---|---|---|
| local-agent-event-to-gui | 40 burst messages 25 ms apart in the follow-up turn; daemon `emittedAt` → MutationObserver sees the `assistant` node (`performance.timeOrigin + now()`, same clock) | 27.4 / 68.3 ms | 25.6 / 41.6 ms | 250 ms |
| route-change | 20 sidebar clicks Needs you ↔ Projects → `<h1>` + no skeleton, next rAF | 31.6 / 32.3 ms | 31.3 / 32.2 ms | 100 ms |
| gui-first-load-warm | 5 reloads of `/` (warm cache), navigation start → `load` | 63.4 / 85.1 ms | 63.7 / 93 ms | 1000 ms |
Caveats: measured against `pnpm dev` (unbundled vite modules, workerd in-process), not a production deploy. Route-change is frame-quantized (two rAFs ≈ 32 ms floor). Event→GUI is DOM insertion, not paint, and includes the page's per-rAF frame batching. CLI cold start 42–54 ms, web initial JS 236.4 KiB, total 264.4 KiB (unchanged).

**Stage 10 gap closed — offline follow-ups**: `Daemon.recoverStale` (first scan after start) now also looks at runs it claimed (`claimedBy === machineId`) in `review`/`failed`; if the last `user.message` seq is after the last `run.state → review|failed` (`hasUnhandledFollowUp`, paged `run.events`), the run is queued in `resumeWanted` and resumed by the same scan (the worker already delivers exactly those messages). Test: review → daemon stopped → `run.message` → new daemon resumes (`stats.resumed === 1`), turn-2 diff has the message; a third start with nothing new does not resume. Only on startup — a room reconnect after a network blip still relies on live notices.

**Stage 8 risk closed — RunLog closes to writers at terminal state**: `RunLog` caches `ended` (lazy: newest `run.state` row by PK desc, then kept current in `insert` from the `run.state` events core appends); `webSocketMessage` replies `{type:'error', code:'forbidden', message:'run has ended'}` for appends once the run is merged/abandoned. Viewer replay/tail unaffected; HTTP `run.append` already re-checked in core. Test: open writer socket → append ok → owner `run.update abandoned` → append → forbidden, log length unchanged.

**Security fix (from the coordinator) — unsafe URL schemes**: zod 4.6 `z.url()` accepts `javascript:`. Contract now has `HttpUrl = z.url({ protocol: /^https?$/ })` (zod 4.6.7 `$ZodURLDef.protocol`, checked in the `.d.ts`/impl; it tests the scheme without the colon). Inputs (`project.create.repoUrl`, `run.update.prUrl`) and `pr.opened.url` use it; outputs `Project.repoUrl` / `Run.prUrl` use `HttpUrl.nullable().catch(null)`, so a legacy unsafe row reads back as `null` instead of failing the command (dispatch returns the parsed output). Web: new `components/external-link.tsx` `ExternalLink` (http(s) only via new `webHref` in `lib/markdown.ts`; anything else renders as plain text `<span data-unsafe-url>`), used for the run page PR fact (`run-pr`), the runs-table PR link (`pr-link`) and the transcript `pr` marker. Markdown links keep `safeHref` (http(s)/mailto). Tests: core rejects `run.update prUrl: 'javascript:alert(1)'` / `data:` and `project.create repoUrl: 'javascript:…'` (invalid_input), legacy row → null; web `external-link.test.ts` renders the link via `react-dom/server` (https → `<a target=_blank rel=noreferrer noopener>`; `javascript:`, ` JavaScript:`, `data:`, `//x` → no `<a>`, no href) and checks a `javascript:` `pr.opened` never becomes a `pr` transcript block while an https one does.

**Results**: `pnpm check && pnpm typecheck && pnpm test && pnpm build && pnpm perf && pnpm gate && pnpm gate:local` passed twice in a row. Timings (pass 1 / pass 2): check 3.2/3.0 s, typecheck 4.6/4.7 s, test 8.5/7.2 s, build 2.9/2.6 s, perf 1.0/1.0 s, gate 9.4/9.7 s, **gate:local 25.7/27.0 s** (dev healthy in 6–7 s; driver ~13 s). Tests: contract 9, adapters 33, core 28, cli 45, api 20, web 27. 1 stock `use-mobile` lint warning (pre-existing).

**Phase 1 status**
- Done (technical gate green): daemon + link + worktrees + claude-code/codex/fake adapters + live run view + follow-ups (live, after review, and while offline) + cancel + commit + draft PR (gh / fake) + Needs-you live + measured latency budgets.
- Not automatable: the human gate (5 engineers daily for a week). Nothing is deployed; the deploy checklist in README is unexercised.

**Known gaps**
- Offline catch-up runs on daemon startup only, not on room reconnect. Daemon scans list ALL runs (`run.list {}`) every room connect / run end.
- Cancelled runs leave the task worktree dirty; worktrees are never removed. Fake adapter restarts its script on resume.
- No daemon-presence API (web always shows the "needs `sf daemon`" hint for local runs). No machine registry; owner check is the only boundary; no project ACLs (any signed-in user reads every run).
- Perf numbers are against `pnpm dev`; no production-build measurement. Web initial JS 236 KiB gzip is heavy. `command-palette-open` has no palette yet.
- gate:local in CI is unverified; real-agent coverage is the manual smoke only. Network egress for agents is unrestricted.
- The developer's dev DB still holds old gate/demo rows → `pnpm db:reset:local` when they choose.

**Suggested Phase 2 start**
1. Dogfood week with the real agents (fix what the 5-engineer gate surfaces first; run `pnpm db:reset:local`, `sf login` against a deployed API — do the deploy checklist).
2. `apps/mcp`: McpAgent server with tools generated from the `@sf/contract` registry (same `dispatch`), plus the `mcp-tool-call` 300 ms budget measured like gate:local.
3. `packages/brain`: org-brain storage + search (`brain-search` 800 ms budget), then skills sync.
4. Small carry-overs: `run.list {state, location}` filter for the daemon, catch-up on reconnect, worktree cleanup on merge/abandon, a daemon heartbeat for the web hint.

---

## Goal of this build: Phase 2 "Brain + registry" (prepped 2026-10-17)

From the plan doc's roadmap widget: **2 · Brain + registry, 4 weeks. Scope: remote MCP server, skills sync, context packs,
project indexing. Gate: brain MCP tools used in half of all runs.** Plan sections: "Org brain and the shared registry" and the
Architecture table in `.handoff/plan.md` (AI Search for retrieval, Queues + Workflows for indexing, McpAgent + OAuth for MCP,
AI Gateway for model calls, R2 for blobs).

Technical gate for this build (`pnpm gate:brain`, final stage): in a linked repo, the daemon starts a fake-agent run whose
context pack contains an org standard + a project file hit + a skill; the fake agent calls `brain.search` over the sf MCP
server and the call is recorded in the RunLog; `sf context` prints the same pack; `sf skills sync` writes the resolved skills
into `.claude/skills/` and `.codex/`; a metric `brain_tool_runs / runs` is computed from RunLog tool calls. Plus a smoke
against the deployed environment.

### Phase 2 decisions (user said "go with your picks", 2026-10-17)
1. **First deploy is stage 1 of Phase 2.** AI Search / Workflows / Queues can't be fully exercised in `pnpm dev`, and the
   dogfood week needs a real URL. wrangler is logged in (ryanyogan@gmail.com). The user must create the GitHub OAuth app
   (callback `<prod-url>/api/auth/callback/github`); everything else follows README's deploy checklist. Keep `SF_DEV_AUTH` off
   in prod. Use `workers.dev` URLs unless the user names a domain.
2. **Registry = a plain GitHub repo** (not Cloudflare Artifacts): `skills/`, `plugins/`, `prompts/`, `org/` in Agent Skills
   SKILL.md format; changes via normal PRs; sf syncs it (webhook or periodic fetch → R2/D1 cache). Artifacts can come later.
3. **Durable facts = markdown in the registry** (`org/decisions/*.md` etc.), not Cloudflare Agent Memory. `decisions.record`
   opens a PR against the registry rather than writing a hidden store.
4. **No brain chat in the GUI this phase.** Ship search, context packs, MCP, skills sync. GUI gets a read-only "Context" panel
   on task/run pages (the pack + citations) and a search box. `sf ask` may be a thin search-and-summarize only if cheap; else defer.
5. **MCP server** = `apps/mcp` (`McpAgent` + OAuth via Better Auth / the existing session), tools GENERATED from `@sf/contract`
   (every command becomes a tool) plus brain tools defined as contract commands too: `brain.search`, `brain.context_for_task`,
   `skills.resolve`, `decisions.record`. One contract, three surfaces stays true.
6. **Daemon injects the brain into every run**: sf MCP server configured for the agent (Claude SDK `mcpServers`, Codex
   config) with the run's credentials, plus the context pack prepended to the first prompt. This is how the "half of all runs"
   gate is reachable without relying on engineers remembering.
7. **Indexing**: per-project AI Search instance; Queue → Workflow chunks code by symbol (start with a simple language-agnostic
   chunker + tree-sitter later if needed), reindexes changed files on push (GitHub webhook), and indexes merged-PR review
   comments. Model/embedding calls go through AI Gateway for cost tracking.
8. Tests never spend tokens or hit remote AI Search: brain behind a `BrainPort` with an in-memory fake in tests and the gate.
9. Each stage ends with check/typecheck/test/build/perf/gate/gate:local passing and one commit. Pushing to origin is allowed
   after a green stage (repo is private; CI is currently blocked by the user's Actions budget, not by code).

### Phase 2 stages (tentative; research may reshape 15–17)
- 13 research → `.handoff/phase2-research.md` (McpAgent + OAuth on Workers, AI Search API + bindings + local-dev story,
  Workflows/Queues, AI Gateway, Claude SDK / Codex MCP config, GitHub webhooks, SKILL.md format, deploy specifics)
- 14 first deploy (api + web + D1 + secrets + GitHub OAuth) + prod smoke; needs the user's OAuth app
- 15 contract brain commands + `BrainPort` + registry sync + `sf skills sync` + `sf context`
- 16 indexing pipeline (Queues/Workflows/AI Search) + GitHub webhook
- 17 `apps/mcp` server generated from the contract + daemon injection
- 18 GUI context panel + search, `pnpm gate:brain`, adoption metric, docs
