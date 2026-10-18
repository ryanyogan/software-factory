# Software Factory

A shared workspace where a team runs coding agents (Claude Code, Codex, ...) against tasks: each task gets a branch, runs happen locally or in the cloud, and the GUI, the `sf` CLI and an MCP server are three views of one API. See `.handoff/plan.md` for the concepts (tasks, runs, two-way handoff, review gate, org brain) and `.handoff/HANDOFF.md` for the build log. Built so far: **Phase 0 "Foundations"** (contract, auth, D1, CLI, perf budget) and **Phase 1 "Local loop"**: `sf daemon` runs agents in a worktree per task, streams them to a live run view in the web app, takes follow-ups from any surface, commits, and opens a draft PR.

## Quickstart

Requires Node 24 and pnpm 11 (`corepack enable`).

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm db:migrate:local
pnpm build                                  # web + the sf CLI (apps/cli/dist/cli.mjs)
pnpm dev                                    # web + api on http://localhost:5173
```

Locally, `SF_DEV_AUTH=1` makes loopback requests act as a seeded `dev` user, so no GitHub app or login is needed. Against a deployed API, `sf login` runs the device flow (`/device`).

### Local loop

In another terminal (`alias sf="node $PWD/apps/cli/dist/cli.mjs"`):

```sh
cd ~/code/my-repo
sf project create --name my-repo --repo https://github.com/me/my-repo   # once (or in the web app)
sf link                     # map this repo to the project (matched by the origin remote; or --project ID)
sf daemon                   # foreground; one per machine. --pr-provider gh|fake|none (default gh)
sf run start --agent claude-code --title "Add a login page" --prompt "add a login page"
```

`--agent` is `claude-code`, `codex` or `fake` (scripted, no tokens; `SF_FAKE_SCRIPT` on the daemon). Without `--title`, `sf run start` uses the task whose branch you are on (so it works from inside a task worktree). Then watch it in the web app (`sf open <run>`) or `sf watch <run>`; steer it with the follow-up box or `sf run message <run> "..."`; stop it with `sf run cancel <run>`. The daemon picks up queued runs over a WebSocket, makes a worktree per task under `$XDG_DATA_HOME/sf/worktrees/<project>/<task>` on the task's branch, commits when the agent finishes, opens a draft PR with `gh` (GitHub origins only), and leaves the run in `review`. A follow-up on a `review` run resumes the same agent session, also when it was sent while the daemon was off.

Agents reuse your existing Claude Code / Codex logins (API keys are stripped from their env unless opted in).

**What's sandboxed**: Claude Code runs with `acceptEdits` plus a path guard (file tools may only touch the worktree, symlinks resolved) and Bash inside the Claude sandbox (bubblewrap on Linux; filesystem writes outside the worktree fail; a missing sandbox fails the run). Codex runs with `sandboxMode: workspace-write`, `approvalPolicy: never`. Network is not restricted. User-global Claude settings are ignored (`settingSources: project, local`).

## Commands

| Command                            | What it does                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm dev`                         | Web (TanStack Start) with the api Worker as an auxiliary worker, port 5173                            |
| `pnpm check`                       | Format check + lint + type-aware lint (`vp check`; `--fix` to fix)                                    |
| `pnpm typecheck`                   | `tsc --noEmit` in every package                                                                       |
| `pnpm test`                        | Vitest (via Vite+) in every package; never spends tokens                                              |
| `pnpm build`                       | Build the web app and the CLI                                                                         |
| `pnpm perf`                        | Perf budgets in `perf-budget.json` (after `pnpm build`; latency from the last `gate:local`)           |
| `pnpm gate`                        | Phase 0 gate: starts dev, CLI creates project/task/run, web page shows it                             |
| `pnpm gate:local`                  | Phase 1 gate: dev + daemon + fake agent + headless chromium, end to end, plus latency budgets (~30 s) |
| `pnpm sf <cmd>`                    | Run the built CLI (`--api` / `SF_API_URL`, `--json`)                                                  |
| `pnpm db:migrate:local`            | Apply D1 migrations to local state (`apps/api/.wrangler/state`, or `SF_STATE_DIR`)                    |
| `pnpm db:reset:local`              | Delete local dev state (all projects/tasks/runs/logs) and re-migrate. Stop `pnpm dev` first           |
| `pnpm --filter @sf/db db:generate` | Generate a Drizzle migration after editing the schema                                                 |

Both gates refuse to start if port 5173 is in use, and run against a temp state dir (`SF_STATE_DIR`), temp `SF_CONFIG_DIR` and `XDG_DATA_HOME`, so they never touch your dev database, CLI config or worktrees. `gate:local` needs chromium: `SF_CHROMIUM=<path>`, `/usr/bin/chromium`, `google-chrome`, or `pnpm exec playwright-core install chromium`; without one it fails. `SF_GATE_KEEP=1` keeps its temp dir.

CI (`.github/workflows/ci.yml`) runs install, check, typecheck, test, build, perf, gate and gate:local with no Cloudflare secrets.

## Layout

```
apps/
  web/      TanStack Start on Cloudflare Workers (sf-web); shadcn/ui; calls the api over a service binding
  api/      sf-api Worker: REST /v1/commands/:name, ApiRpc entrypoint, ProjectRoom/RunLog DOs, Better Auth
  cli/      sf — citty, bundled to dist/cli.mjs; `sf daemon` (worktrees, adapters, RunLog writer, PRs)
  mcp/      stub; remote MCP server (McpAgent) lands in Phase 2, generated from @sf/contract
packages/
  contract/ zod command registry + typed HTTP client — the one API
  core/     command handlers + dispatch(ctx, name, input)
  db/       Drizzle schema + D1 migrations (packages/db/drizzle)
  ui/       shadcn/ui components
  config/   shared tsconfig
  adapters/ agent adapters (claude-code, codex, fake) behind one AgentSession interface
  brain/    stub (Phase 2)
scripts/    gate.sh, gate-local.sh (+ gate-local.mjs browser driver), perf-budget.mjs
```

Adding a command = contract definition + core handler + test; every surface picks it up from the registry.

## What's next (Phase 2)

Phase 1's human gate is 5 engineers using the local loop daily for a week. Phase 2 per the plan: the org brain, the remote MCP server (`apps/mcp`, tools generated from `@sf/contract`) and skills sync. Later: cloud runs in a Sandbox, `sf push`/`sf pull`, preview URLs and an embedded terminal (3), the final review gate and Slack (4).

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
