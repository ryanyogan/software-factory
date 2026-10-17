<!-- intent-skills:start -->

## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before editing files for a substantial task:

- Run `pnpm exec intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm exec intent load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

# Software Factory

pnpm monorepo (pnpm 11, node 24) on VoidZero tooling via Vite+ (`vp`). Build log and decisions: `.handoff/HANDOFF.md`.

## Layout

- `apps/` — `web` (TanStack Start on Cloudflare), `api` (`sf-api` Worker: REST `/v1/commands/:name` + `ApiRpc` RPC entrypoint + `ProjectRoom`/`RunLog` DOs + Better Auth), `cli` (`sf`), `mcp`.
- `packages/contract` — zod command definitions (`commands` registry) + typed HTTP `createClient`. The one API.
- `packages/core` — handlers keyed by command name + `dispatch(ctx, name, rawInput)`.
- `packages/db` — Drizzle schema for D1; migrations in `packages/db/drizzle`.
- `packages/ui` — shadcn/ui components (stage 4). `packages/adapters`, `packages/brain` — stubs.
- `packages/config` — shared `tsconfig.base.json`.

Internal packages export TypeScript source directly (`exports: "./src/index.ts"`); no build step.

## Commands (from repo root)

- `pnpm check` — format check + lint + type-aware lint/type-check (`vp check`; `pnpm exec vp check --fix` to fix)
- `pnpm fmt` — format everything (`vp fmt`)
- `pnpm test` — `vp run -r test` (Vitest 5 via Vite+; import from `vite-plus/test`)
- `pnpm typecheck` — `tsc --noEmit` in every package
- `pnpm build` — `vp run -r build`
- `pnpm dev` — web + api (auxiliary worker) on http://localhost:5173; `pnpm db:migrate:local` first (shared state in `apps/api/.wrangler/state`)
- `pnpm sf <cmd>` — run the built CLI (`pnpm --filter @sf/cli build` first; `--api`/`SF_API_URL`, default http://localhost:5173)
- `pnpm gate` — Phase 0 gate (`scripts/gate.sh`): starts dev, CLI creates project/task/run, asserts the web task page lists the run, stops dev
- shadcn: run `pnpm dlx shadcn@4.22.0 add <component>` from `apps/web` (writes to `packages/ui`)
- `pnpm --filter @sf/db db:generate` — generate a Drizzle migration after editing `packages/db/src/schema.ts`

## Rules

- Every surface (web, CLI, MCP) goes through `@sf/core` `dispatch` with names from `@sf/contract`. Add a command = contract def + handler + test.
- Config files import `defineConfig` from `vite-plus`; tests import from `vite-plus/test`.
- `vite` is overridden to `@voidzero-dev/vite-plus-core` in `pnpm-workspace.yaml`; don't add a separate `vite`/`vitest` version.
- Fetch current docs (Context7) before using version-dependent APIs. Use the Cloudflare skills for Workers/DO/wrangler work.
