# Research — Phase 0 Foundations (2026-10-17)

Sources: npm registry (`npm view`, run 2026-10-17), Context7 (viteplus.dev guide, tanstack.com/start, developers.cloudflare.com, ui.shadcn.com, orm.drizzle.team, better-auth repo docs, tanstack/intent, tanstack/cli). WebFetch was unavailable this session. Anything not confirmed by those is marked **UNVERIFIED**.

Local machine: node v24.22.0, pnpm 11.17.0, bun installed (mise), no global `vp`.

## Recommended choices

1. **Use Vite+ (`vite-plus@1.3.0`, stable `latest`) installed locally** at the workspace root (`pnpm add -Dw vite-plus`, run as `pnpm exec vp ...`). One root `vite.config.ts` holds `lint` / `fmt` / `staged` / `run.tasks`. Tasks run with `vp run -r <task>`. It bundles oxlint 1.88.0, oxfmt 0.73.0, vitest 5.0.5, and tsdown (`vp pack`). Fallback (oxlint + oxfmt + vitest + `pnpm -r`) is documented below in case it breaks with TanStack Start or the Cloudflare plugin.
2. **apps/web: TanStack Start `@tanstack/react-start@1.169.3` + `@cloudflare/vite-plugin@1.64.0` + `wrangler@4.151.1`.** `main: "@tanstack/react-start/server-entry"`. Read bindings with `import { env } from "cloudflare:workers"` inside server functions and server routes. Scaffold with `npx @tanstack/cli@latest create web --deployment cloudflare --package-manager pnpm --intent -y` (or `pnpm create cloudflare@latest web --framework=tanstack-start`).
3. **apps/api: a standalone Worker** that exposes a named `WorkerEntrypoint` (RPC) plus a default `fetch` (REST for the CLI, WebSocket upgrade to DOs). It owns the D1 binding and the `ProjectRoom` / `RunLog` SQLite-backed DOs (`new_sqlite_classes`, hibernation API). **apps/web calls apps/api through a service binding with RPC.** The CLI calls the api's HTTP `fetch` surface. Both surfaces dispatch into the same `packages/contract` handlers, which is what satisfies the gate.
4. **Dev: one `vite dev` in apps/web with `auxiliaryWorkers: [{ configPath: "../api/wrangler.jsonc" }]`.** This is Cloudflare's recommended single-command multi-worker setup. Use `compatibility_date: "2026-10-01"`. The workerd bundled with wrangler 4.151.1 is 1.20261012.1, so any date up to 2026-10-12 is supported locally. Type env with `wrangler types -c wrangler.jsonc -c ../api/wrangler.jsonc`.
5. **D1 + `drizzle-orm@0.45.4` / `drizzle-kit@0.31.11`** (stay on `latest`, not the 1.0 rc). `drizzle-kit generate` writes SQL into `packages/db/drizzle`. api's `wrangler.jsonc` points `migrations_dir` at that folder, and migrations apply with `wrangler d1 migrations apply DB --local`.
6. **Auth: `better-auth@1.7.10`** + `@better-auth/drizzle-adapter@1.7.10` (sqlite), GitHub social provider, and the plugins **`deviceAuthorization()` + `bearer()`**. The CLI runs the device flow (`/device/code` then poll `/device/token`), stores the session token, and sends `Authorization: Bearer <token>`. Schema comes from `npx auth@latest generate --adapter drizzle --dialect sqlite`. Mount auth in apps/api.
7. **CLI: `citty@0.2.2`** for args (tiny, typed subcommands). Build with tsdown via `vp pack` (`tsdown@0.23.1` underneath). Run with `node dist/cli.mjs`. A Bun-compiled binary comes later.
8. **UI: `shadcn@4.22.0`, Tailwind `4.3.3` (`@tailwindcss/vite`).** Use the shadcn monorepo layout: `components.json` in both `apps/web` and `packages/ui`, with an empty `tailwind.config`. The `shadcn init --monorepo` template scaffolds Turborepo, so either delete `turbo.json` afterwards or hand-write the two `components.json` files.
9. **Agent skills:** `npx @tanstack/intent@latest install` (writes the intent-skills block into CLAUDE.md / AGENTS.md), `npx skills add shadcn/ui`, and optionally `pnpm dlx shadcn@latest mcp init --client claude`. The Cloudflare skills are already available as `cloudflare:*` plugin skills.

---

## 1. Vite+ (`vite-plus`, `vp`)

**Status: publicly available and stable.** `npm view vite-plus` gives `latest: 1.3.0` (bins `vp`, `vpr`). It depends on vite (aliased to `@voidzero-dev/vite-plus-core@1.3.0`), `oxlint =1.88.0`, `oxfmt =0.73.0`, `vitest 5.0.5`, and `oxlint-tsgolint`. Engines: node `^22.18 || ^24.11 || >=26`, so the local node 24.22 is fine.

### Setup (local-only, no global CLI)

```bash
pnpm add -Dw vite-plus
# or migrate an existing repo:
pnpm dlx --package=vite-plus vp migrate --no-interactive
pnpm install && pnpm exec vp check && pnpm exec vp test
```

New project path: `pnpm dlx --package=vite-plus vp create`. For a global CLI, `vp install` / `vp env use 26` exist, but the global install command is **UNVERIFIED**. Use the local install.

### Required pnpm overrides (manual setup)

These keep one vite and one vitest copy across the workspace. Put them in `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
overrides:
  vite: npm:@voidzero-dev/vite-plus-core@1.3.0
  vitest: 5.0.5   # must equal the vitest Vite+ bundles (check `vp --version`)
```

### Import rewrites

- In config files: `import { defineConfig } from 'vite-plus'` (instead of `vite` / `vitest/config`).
- In tests: `import { describe, expect, it, vi } from 'vite-plus/test'`.
- Other `vite` imports keep working through the alias. Plugin packages are not rewritten.

### Root `vite.config.ts` (monorepo defaults; per-package `vite.config.ts` still holds Vite/framework/test config)

```ts
import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: ['**/dist/**', '**/.wrangler/**', '**/worker-configuration.d.ts', '**/routeTree.gen.ts'],
    plugins: ['typescript'],
    options: { typeAware: true, typeCheck: true }, // vp check also type-checks
    overrides: [
      { files: ['apps/web/**', 'packages/ui/**'], plugins: ['react'] },
      { files: ['**/*.test.ts'], plugins: ['vitest'] },
    ],
  },
  fmt: { singleQuote: true, semi: true },
  staged: { '*.{js,ts,tsx}': 'vp check --fix' },
  run: {
    tasks: {
      // cached tasks; package.json scripts also work with `vp run`
    },
  },
});
```

### Commands and root scripts

```json
{
  "scripts": {
    "check": "vp check",
    "lint": "vp lint",
    "fmt": "vp fmt",
    "test": "vp test",
    "build": "vp run -r build",
    "typecheck": "vp run -r typecheck"
  }
}
```

- `vp check` runs fmt, lint, and type-check.
- `vp run -r <task>` runs a task in every package in dependency order (deps come from `package.json`). The self-reference in a root script is pruned automatically.
- `vp run` filter syntax for a single package is **UNVERIFIED**. Use `pnpm --filter <pkg> <script>` for that.
- `vp pack` is tsdown (a `pack` block in `vite.config.ts`).
- `vp staged` is the pre-commit hook.

**Risk (UNVERIFIED):** TanStack Start (needs vite >=8) and `@cloudflare/vite-plugin` (vite ^6 || ^7 || ^8) running on `vite-plus-core` has not been verified by a smoke test. They should work because vite-plus-core is Vite 8-based and the alias is transparent, but the scaffold stage must run `vp dev` / `vp build` in apps/web early. In per-app `vite.config.ts`, keep `import { defineConfig } from 'vite'` or `'vite-plus'`; either resolves.

### Fallback (if Vite+ breaks)

Packages: `oxlint@1.88.0`, `oxfmt@0.73.0`, `vitest@5.0.5`, `vite@8.3.4`, `tsdown@0.23.1`.

- Config files: `.oxlintrc.json` (`{"plugins":["typescript","react","vitest"],"ignorePatterns":["dist"]}`), `.oxfmtrc.json`, a per-package `vitest.config.ts`, and `vitest.config.ts` at the root with `test.projects: ['apps/*','packages/*']`. The exact oxfmt config file name is **UNVERIFIED**; run `oxfmt --init`.
- Root scripts: `"lint":"oxlint"`, `"fmt":"oxfmt"`, `"test":"vitest run"`, `"build":"pnpm -r build"`, `"typecheck":"pnpm -r typecheck"`, `"dev":"pnpm --filter web dev"`.

## 2. TanStack Start on Cloudflare Workers

Versions:

| Package | Version |
|---|---|
| `@tanstack/react-start` | 1.169.3 (peer vite >=8, react >=18) |
| `@tanstack/react-router` | 1.170.45 |
| `@tanstack/react-query` | 5.104.3 |
| `@cloudflare/vite-plugin` | 1.64.0 (peer wrangler ^4.151.0) |
| `wrangler` | 4.151.1 |
| `@vitejs/plugin-react` | not checked, use latest |

Scaffold (either):

```bash
npx @tanstack/cli@latest create web --deployment cloudflare --package-manager pnpm --intent --no-git -y   # @tanstack/cli 0.72.0; add --blank for minimal
pnpm create cloudflare@latest web --framework=tanstack-start                                             # create-cloudflare 2.74.0
```

The blank template omits Tailwind and Intent, so `--blank` needs `--intent` passed explicitly. A non-empty target requires `--force`.

`apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      auxiliaryWorkers: [{ configPath: '../api/wrangler.jsonc' }], // see §5
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
```

`apps/web/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "sf-web",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": "@tanstack/react-start/server-entry",
  "observability": { "enabled": true },
  "services": [{ "binding": "API", "service": "sf-api", "entrypoint": "ApiRpc" }]
}
```

Bindings are available in server functions, server routes, and middleware:

```ts
import { createServerFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';

export const createTask = createServerFn({ method: 'POST' })
  .inputValidator((d: { title: string }) => d)
  .handler(async ({ data }) => env.API.taskCreate(data)); // RPC over service binding
```

- Read env per request or via `cloudflare:workers`. Never use `process.env` at module scope.
- Scripts: `"dev":"vite dev"`, `"build":"vite build"`, `"preview":"vite preview"`, `"deploy":"vite build && wrangler deploy"`, `"cf-typegen":"wrangler types"`.

## 3. TanStack agent skills (TanStack Intent)

`@tanstack/intent@0.5.5` (bin `intent`) ships skills inside npm packages. Consumers discover them from `node_modules`.

```bash
npx @tanstack/intent@latest install          # writes/updates an <!-- intent-skills:start --> ... <!-- intent-skills:end --> block
                                             # in AGENTS.md (created if missing) / CLAUDE.md / .cursorrules / .github/copilot-instructions.md
npx @tanstack/intent@latest list             # list skills from workspace deps (--json)
npx @tanstack/intent@latest load <pkg>#<skill>
npx @tanstack/intent@latest hooks install --scope project --agents claude   # optional: Claude Code hooks that surface skills / gate edits until a skill is loaded
```

The injected block tells the agent to run `pnpm dlx @tanstack/intent@latest list` from the workspace root and `load <package>#<skill>` before editing. Run `install` after deps are installed, at the repo root. Exact flags for choosing which file `install` targets are **UNVERIFIED**; see `intent install --help`. The `@tanstack/cli create ... --intent` flag also sets this up.

## 4. shadcn/ui

`shadcn@4.22.0` (CLI v4), `tailwindcss@4.3.3`, `@tailwindcss/vite@4.3.3`.

```bash
pnpm dlx shadcn@latest init -t start --monorepo   # TanStack Start monorepo template (apps/web + packages/ui), BUT it scaffolds Turborepo
```

The project does not use Turborepo, so pick one:

- (a) Run it in a scratch dir and copy `packages/ui` + the `components.json` files across.
- (b) Hand-write both `components.json` files as below and run `pnpm dlx shadcn@latest add button` from `apps/web`.

Rules: every workspace that installs components has a `components.json`. `style`, `iconLibrary`, and `baseColor` must match. For Tailwind v4, `tailwind.config` is `""`.

`packages/ui/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova", "rsc": false, "tsx": true,
  "tailwind": { "config": "", "css": "src/styles/globals.css", "baseColor": "neutral", "cssVariables": true },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@workspace/ui/components", "utils": "@workspace/ui/lib/utils",
    "hooks": "@workspace/ui/hooks", "lib": "@workspace/ui/lib", "ui": "@workspace/ui/components"
  }
}
```

`apps/web/components.json`: same, but `"css": "../../packages/ui/src/styles/globals.css"` and aliases `components:@/components, hooks:@/hooks, lib:@/lib, utils:@workspace/ui/lib/utils, ui:@workspace/ui/components`.

- `@workspace/ui` is the docs' package name. Rename it to e.g. `@sf/ui` consistently.
- `"style": "base-nova"` is the docs' monorepo example (Base UI). Choosing Radix instead (`new-york` / radix-based styles) is a CLI prompt. Either works.

Tailwind v4: no `tailwind.config.js`. `globals.css` starts with `@import "tailwindcss";` plus the shadcn CSS variables. Add `@source "../../../apps/web/src";` so the web app's classes are scanned; this is standard Tailwind v4 practice, and the exact path is **UNVERIFIED** until scaffolded.

Agent skills / MCP:

```bash
npx skills add shadcn/ui                          # shadcn/skills (skills@1.7.2 CLI); covers Radix + Base UI, CLI flags, registry workflows
pnpm dlx shadcn@latest mcp init --client claude   # optional MCP server for Claude Code; restart Claude Code after
```

## 5. Cloudflare: api Worker, DOs, service binding, dev

| Item | Value |
|---|---|
| `wrangler` | 4.151.1 |
| `workerd` | 1.20261016.1 latest; wrangler 4.151.1 bundles 1.20261012.1 |
| `@cloudflare/workers-types` | 5.20261016.1 (prefer `wrangler types` output over this package) |
| `compatibility_date` | **`"2026-10-01"`** (≥ 2026-04-07 also enables `web_socket_auto_reply_to_close`) |

`apps/api/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "sf-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "sf", "database_id": "<from wrangler d1 create sf>", "migrations_dir": "../../packages/db/drizzle" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "PROJECT_ROOM", "class_name": "ProjectRoom" },
      { "name": "RUN_LOG", "class_name": "RunLog" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ProjectRoom", "RunLog"] }]
}
```

`apps/api/src/index.ts` shape:

```ts
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

export class ProjectRoom extends DurableObject<Env> {
  async fetch(req: Request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);            // hibernatable
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) { /* ... */ }
  async webSocketClose(ws: WebSocket, code: number, reason: string) { ws.close(code, reason); }
  // SQLite: this.ctx.storage.sql.exec('SELECT ...', ...args).toArray()
}
export class RunLog extends DurableObject<Env> { /* same pattern; append-only events table, replay from seq */ }

export class ApiRpc extends WorkerEntrypoint<Env> {   // named entrypoint for service binding
  async taskCreate(input: unknown) { /* contract dispatch */ }
  async runStart(input: unknown) { /* contract dispatch */ }
}

export default {
  async fetch(req, env, ctx) { /* REST for CLI: /v1/:command -> contract dispatch; /api/auth/* -> better-auth; WS upgrade -> DO stub.fetch */ },
} satisfies ExportedHandler<Env>;
```

Calling the api from web: **RPC via service binding** (`env.API.taskCreate(...)`). It is typed, has no URL or JSON plumbing, and costs no extra request. `fetch` over the binding (`env.API.fetch(req)`) also works and is the fallback for proxying WebSocket upgrades or auth routes. A named entrypoint needs `"entrypoint": "ApiRpc"` in the binding.

Env typing:

- `apps/api`: `wrangler types` writes `worker-configuration.d.ts` with a global `Env`.
- `apps/web`: `wrangler types -c wrangler.jsonc -c ../api/wrangler.jsonc` adds the RPC types for `Service<ApiRpc>`.
- Add both as `typecheck` prerequisites.

Local dev (recommended):

- One command, `vite dev` in apps/web, with `auxiliaryWorkers: [{ configPath: '../api/wrangler.jsonc' }]`. The api Worker runs in the same Miniflare instance, so service bindings, DOs, and D1 local state all work.
- The first config is the entry Worker. Auxiliary Workers are reachable only through bindings, not on their own port.
- The CLI therefore needs an HTTP path to the api. Either route `/v1/*` in web through `env.API.fetch(request)` (a server route proxy, simplest), or also run `wrangler dev` in apps/api for a standalone port. Separate sessions connect through the local dev registry; that detail is **UNVERIFIED**.
- Wrangler alternative: `wrangler dev -c apps/web/wrangler.jsonc -c apps/api/wrangler.jsonc`. It does not apply to TanStack Start, which needs Vite.

**Note:** with auxiliaryWorkers, local D1 state lives under apps/web's `.wrangler/state`. When applying migrations locally for that session, use `--persist-to` to point at the same state dir. This is **UNVERIFIED**; the scaffold stage must confirm which `.wrangler` dir the vite plugin uses.

## 6. Drizzle + D1

Versions: `drizzle-orm@0.45.4`, `drizzle-kit@0.31.11` (`latest`). 1.0.0-rc.5 exists on the `rc` tag; do not use it in Phase 0.

`packages/db/drizzle.config.ts` (generate only needs dialect, schema, and out; `d1-http` creds are only for remote `migrate`/`studio`):

```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  // driver: 'd1-http', dbCredentials: { accountId, databaseId, token }  // optional, remote only
});
```

Commands:

```bash
pnpm --filter @sf/db exec drizzle-kit generate                        # writes drizzle/0000_*.sql
cd apps/api && pnpm exec wrangler d1 migrations apply DB --local      # uses migrations_dir from wrangler.jsonc
pnpm exec wrangler d1 migrations apply DB --remote                    # prod
```

Runtime: `import { drizzle } from 'drizzle-orm/d1'; const db = drizzle(env.DB, { schema });`

## 7. Auth (Better Auth)

Versions: `better-auth@1.7.10` (`latest`; 1.8.0-beta.1 on the `beta` tag), `@better-auth/drizzle-adapter@1.7.10`. The schema CLI is the npm package **`auth@1.7.10`** (`npx auth@latest`). `@better-auth/cli` stopped at 1.4.21; do not use it. The adapter is also importable as `better-auth/adapters/drizzle`.

`apps/api/src/auth.ts`:

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { bearer, deviceAuthorization } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import { env } from 'cloudflare:workers';
import * as schema from '@sf/db/schema';

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,           // e.g. http://localhost:5173
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: 'sqlite' }),
  socialProviders: { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } },
  plugins: [deviceAuthorization({ verificationUri: '/device' }), bearer()],
});
// in fetch: if (url.pathname.startsWith('/api/auth/')) return auth.handler(request);
```

- Secrets go in `.dev.vars` locally and `wrangler secret put` in prod.
- Generate tables: `npx auth@latest generate --adapter drizzle --dialect sqlite --output packages/db/src/auth-schema.ts --config apps/api/src/auth.ts -y`. The CLI may not load a file importing `cloudflare:workers`; if so, point it at a plain config that takes env as args. That is **UNVERIFIED**.
- GitHub OAuth callback: `<baseURL>/api/auth/callback/github`. This is the standard Better Auth path, from memory, not docs.
- Web: `createAuthClient` from `better-auth/react`, then `authClient.signIn.social({ provider: 'github' })`. The web app needs a `/device` page where a signed-in user enters or approves the `user_code`. The approve/deny client calls (`authClient.device.approve/deny`) are **UNVERIFIED**; check the plugin docs.

**Simplest CLI path (Phase 0):** device authorization plus bearer.

1. `sf login` creates an auth client with `deviceAuthorizationClient()`.
2. It calls `authClient.device.code({ client_id: 'sf-cli' })`, prints `user_code`, and opens `verification_uri_complete` (with `open@11.0.4`).
3. It polls `authClient.device.token({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: 'sf-cli' })`, handling `authorization_pending` and `slow_down` (+5s).
4. It stores `access_token`, a Better Auth session token, in `~/.config/sf/credentials.json`.
5. Every request sends `Authorization: Bearer <token>`. The api resolves it with `auth.api.getSession({ headers })`.

Use `/device/token`, not the `oauthProvider` + `/oauth2/token` path, which is for third-party clients. Allowed `client_id`s can be validated in the plugin options (option name **UNVERIFIED**).

## 8. CLI (apps/cli)

- `tsdown@0.23.1`. Under Vite+, use a `pack` block in `apps/cli/vite.config.ts` and build with `vp pack`.
- `citty@0.2.2`: chosen, unjs, tiny, `defineCommand` + `subCommands`, typed args. `commander@15.0.0` is the alternative.

```ts
// apps/cli/vite.config.ts
import { defineConfig } from 'vite-plus';
export default defineConfig({ pack: { entry: ['src/cli.ts'], format: ['esm'], platform: 'node', dts: false } });
```

```ts
// apps/cli/src/cli.ts
#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
const main = defineCommand({
  meta: { name: 'sf', version: '0.0.0' },
  subCommands: { login: () => import('./commands/login').then(m => m.default), task: () => import('./commands/task').then(m => m.default) },
});
runMain(main);
```

- `package.json`: `"type":"module"`, `"bin":{"sf":"./dist/cli.mjs"}`, `"build":"vp pack"`. The output filename (`.mjs` vs `.js`) depends on the tsdown default and is **UNVERIFIED**; check `dist/` after the first build.
- Shebang preservation by tsdown is **UNVERIFIED**; add a `banner` option if it is missing.
- Run: `node apps/cli/dist/cli.mjs task create --title x --json`, or `pnpm --filter @sf/cli exec sf ...` after `pnpm install` links the bin.
- Later: `bun build --compile`, or `vp pack` with `exe: true` (Node SEA, needs node ≥25.7).
