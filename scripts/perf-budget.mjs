#!/usr/bin/env node
// Perf budget check (`pnpm perf`). Run after `pnpm build`. Budgets live in perf-budget.json;
// entries with `measured: false` are listed so they stay visible but are not enforced yet.
// Exit 1 if any measured budget is exceeded.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(root, 'perf-budget.json'), 'utf8'));
const budgets = Object.fromEntries(config.budgets.map((b) => [b.id, b]));
const results = [];

function need(path, hint) {
  if (!existsSync(path)) {
    console.error(`perf: missing ${path} — ${hint}`);
    process.exit(1);
  }
}

// --- sf CLI cold start: median wall time of `node apps/cli/dist/cli.mjs --help` ---
const cli = join(root, 'apps/cli/dist/cli.mjs');
need(cli, 'run `pnpm build` first');
const runs = Number(process.env.PERF_CLI_RUNS ?? 11);
spawnSync(process.execPath, [cli, '--help']); // warm the OS file cache, not node
const times = [];
for (let i = 0; i < runs; i++) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [cli, '--help'], { stdio: 'ignore' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) {
    console.error(`perf: sf --help exited ${r.status}`);
    process.exit(1);
  }
  times.push(ms);
}
times.sort((a, b) => a - b);
results.push({ id: 'cli-cold-start', value: Math.round(times[Math.floor(times.length / 2)]) });

// --- Web client JS (gzip) ---
const assets = join(root, 'apps/web/dist/client/assets');
need(assets, 'run `pnpm build` first');
const jsFiles = readdirSync(assets).filter((f) => f.endsWith('.js'));
const gz = (f) => gzipSync(readFileSync(join(assets, f)), { level: 9 }).length;

// Entry chunk: the module script the TanStack Start manifest injects for __root__.
const serverAssets = join(root, 'apps/web/dist/server/assets');
const manifest = readdirSync(serverAssets).find((f) => f.startsWith('_tanstack-start-manifest'));
const entry = manifest
  ? readFileSync(join(serverAssets, manifest), 'utf8').match(/src:\s*"\/assets\/([^"]+\.js)"/)?.[1]
  : undefined;
if (!entry || !jsFiles.includes(entry)) {
  console.error('perf: could not find the web entry chunk in the TanStack Start manifest');
  process.exit(1);
}
// Initial load = entry + its static import closure (root route code is bundled with the entry).
const initial = new Set();
const visit = (f) => {
  if (initial.has(f)) return;
  initial.add(f);
  const src = readFileSync(join(assets, f), 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) visit(m[1]);
};
visit(entry);
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;
results.push({ id: 'web-initial-js-gzip', value: kb([...initial].reduce((s, f) => s + gz(f), 0)) });
results.push({ id: 'web-total-js-gzip', value: kb(jsFiles.reduce((s, f) => s + gz(f), 0)) });

// --- Latency budgets: measured in a real browser by `pnpm gate:local` (scripts/gate-local.mjs),
// which enforces them itself and records p95s in .perf/gate-local.json. Re-checked here when present.
const latencyFile = join(root, '.perf/gate-local.json');
const latency = existsSync(latencyFile) ? JSON.parse(readFileSync(latencyFile, 'utf8')) : null;
const fromGate = config.budgets.filter((b) => b.source === 'gate:local');
for (const b of fromGate) {
  if (latency?.[b.id])
    results.push({ id: b.id, value: latency[b.id].p95, note: 'p95, gate:local' });
}

// --- Report ---
let failed = false;
console.log('perf budget');
for (const { id, value, note } of results) {
  const b = budgets[id];
  const ok = value <= b.budget;
  failed ||= !ok;
  const extra = note ? `, ${note}` : '';
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${id}: ${value} ${b.unit} (budget ${b.budget}${extra})`);
}
if (fromGate.length && !latency) {
  console.log(`  note ${fromGate.map((b) => b.id).join(', ')}: run \`pnpm gate:local\` to measure`);
} else if (latency) {
  console.log(`  (latency from .perf/gate-local.json, ${latency.at})`);
}
for (const b of config.budgets.filter((b) => b.measured === false)) {
  console.log(`  todo ${b.id}: ${b.budget} ${b.unit} p95 — not measured yet`);
}
if (failed) {
  console.error('perf: budget exceeded');
  process.exit(1);
}
