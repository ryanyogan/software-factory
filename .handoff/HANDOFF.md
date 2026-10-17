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
