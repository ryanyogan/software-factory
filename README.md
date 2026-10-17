# Software Factory

A shared workspace where a team runs coding agents (Claude Code, Codex, ...) against tasks: each task gets a branch, runs happen locally or in the cloud, and the GUI, the `sf` CLI and an MCP server are three views of one API. See `.handoff/plan.md` for the concepts (tasks, runs, two-way handoff, review gate, org brain) and `.handoff/HANDOFF.md` for the build log. This repo is **Phase 0 "Foundations"**: contract package, auth, D1 schema, CLI skeleton and a CI perf budget, gated on the CLI and web calling one API for `task.create` and `run.start`.

## Quickstart

Requires Node 24 and pnpm 11 (`corepack enable`).

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm db:migrate:local
pnpm dev                                    # web + api on http://localhost:5173
pnpm --filter @sf/cli build && pnpm sf project list   # in another terminal
```

Locally, `SF_DEV_AUTH=1` makes loopback requests act as a seeded `dev` user, so no GitHub app is needed. `sf login` runs the device flow against `/device`.

## Commands

| Command                            | What it does                                                               |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`                         | Web (TanStack Start) with the api Worker as an auxiliary worker, port 5173 |
| `pnpm check`                       | Format check + lint + type-aware lint (`vp check`; `--fix` to fix)         |
| `pnpm typecheck`                   | `tsc --noEmit` in every package                                            |
| `pnpm test`                        | Vitest (via Vite+) in every package                                        |
| `pnpm build`                       | Build the web app and the CLI                                              |
| `pnpm perf`                        | Perf budget check against `perf-budget.json` (run after `pnpm build`)      |
| `pnpm gate`                        | Phase 0 gate: starts dev, CLI creates project/task/run, web page shows it  |
| `pnpm sf <cmd>`                    | Run the built CLI (`--api` / `SF_API_URL`, `--json`)                       |
| `pnpm db:migrate:local`            | Apply D1 migrations to local state                                         |
| `pnpm --filter @sf/db db:generate` | Generate a Drizzle migration after editing the schema                      |

CI (`.github/workflows/ci.yml`) runs install, check, typecheck, test, build, perf and gate with no Cloudflare secrets.

## Layout

```
apps/
  web/      TanStack Start on Cloudflare Workers (sf-web); shadcn/ui; calls the api over a service binding
  api/      sf-api Worker: REST /v1/commands/:name, ApiRpc entrypoint, ProjectRoom/RunLog DOs, Better Auth
  cli/      sf — citty, bundled to dist/cli.mjs
  mcp/      stub; remote MCP server (McpAgent) lands in Phase 2, generated from @sf/contract
packages/
  contract/ zod command registry + typed HTTP client — the one API
  core/     command handlers + dispatch(ctx, name, input)
  db/       Drizzle schema + D1 migrations (packages/db/drizzle)
  ui/       shadcn/ui components
  config/   shared tsconfig
  adapters/, brain/   stubs
scripts/    gate.sh, perf-budget.mjs
```

Adding a command = contract definition + core handler + test; every surface picks it up from the registry.

## What's next (Phase 1)

The roadmap table did not survive the plan export, so this is from the plan's v1 capability list: local daemon runs with a worktree per task, the live run view (transcript, diff, terminal, preview) streamed through `RunLog`, the review queue and final-review gate, and measuring the perf budgets that are still `measured: false` in `perf-budget.json` (route change, GUI first load, agent event to GUI). The MCP server follows in Phase 2.

## Deploy checklist

Nothing is deployed yet. To deploy to Cloudflare:

1. `cd apps/api && pnpm exec wrangler d1 create sf`, then put the returned `database_id` in `apps/api/wrangler.jsonc` (replacing the all-zero placeholder).
2. Set secrets on the api Worker:
   `pnpm exec wrangler secret put BETTER_AUTH_SECRET` (32+ random chars), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (GitHub OAuth app with callback `<prod-url>/api/auth/callback/github`).
3. In `apps/api/wrangler.jsonc` `vars`, set `BETTER_AUTH_URL` and `WEB_ORIGIN` to the production web URL. Do **not** set `SF_DEV_AUTH` in production.
4. Apply migrations remotely: `pnpm --filter @sf/api db:migrate:remote`.
5. Deploy the api first (the web Worker binds to it): `pnpm --filter @sf/api deploy`.
6. Deploy the web app: `pnpm --filter @sf/web deploy`.
7. Point the CLI at it: `SF_API_URL=<prod-url> pnpm sf login`.

A commented-out `deploy` job in `ci.yml` does steps 4–6 with `CLOUDFLARE_API_TOKEN` once secrets exist.
