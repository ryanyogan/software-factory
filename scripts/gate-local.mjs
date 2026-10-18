#!/usr/bin/env node
// Browser driver for `pnpm gate:local` (started by scripts/gate-local.sh with dev + daemon running).
// Asserts the local loop through the API, git and headless chromium, and measures three perf budgets
// on the same machine clock (see perf-budget.json):
//   local-agent-event-to-gui  daemon `emittedAt` (Date.now() when the agent event is queued)
//                             → the run page's DOM gets that message (MutationObserver, wall clock)
//   route-change              sidebar click → the target page's <h1> rendered, data loaded
//   gui-first-load-warm       reload of / with a warm cache → `load` event
// Writes .perf/gate-local.json (read by `pnpm perf`) and exits 1 on any failure or exceeded budget.
// `--check-browser` only checks that chromium exists.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const root = new URL('..', import.meta.url).pathname;

function findChromium() {
  const candidates = [
    process.env.SF_CHROMIUM,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

const { values: args } = parseArgs({
  options: {
    'check-browser': { type: 'boolean' },
    base: { type: 'string' },
    repo: { type: 'string' },
    project: { type: 'string' },
    cli: { type: 'string' },
    data: { type: 'string' },
  },
});

const { chromium } = await import('playwright-core');
let executablePath = findChromium();
if (!executablePath) {
  // Playwright's own download (`pnpm exec playwright-core install chromium`), e.g. in CI.
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) executablePath = bundled;
}
if (args['check-browser']) {
  if (!executablePath) {
    console.error('gate:local: no chromium. Set SF_CHROMIUM, install chromium, or run');
    console.error('  pnpm exec playwright-core install chromium');
    process.exit(1);
  }
  process.exit(0);
}

const BASE = args.base;
const t0 = Date.now();
const step = (s) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s ${s}`);
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function api(name, input) {
  const res = await fetch(`${BASE}/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${name}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}
const events = async (id) => (await api('run.events', { id, since: 0, limit: 1000 })).events;
async function waitFor(fn, what, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const sf = async (argv) =>
  (await run(process.execPath, [args.cli, ...argv], { cwd: args.repo, env: process.env })).stdout;
const git = async (argv) => (await run('git', ['-C', args.repo, ...argv])).stdout.trim();
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const r1 = (x) => Math.round(x * 10) / 10;

// In-page probe: wall-clock arrival of every assistant message, and when the run socket went live.
function probe() {
  const w = /** @type {any} */ (window);
  w.__sf = { recs: [], liveAt: null };
  const seen = new WeakSet();
  const now = () => performance.timeOrigin + performance.now();
  const scan = () => {
    const t = now();
    for (const el of document.querySelectorAll('[data-testid=assistant]')) {
      if (seen.has(el)) continue;
      seen.add(el);
      w.__sf.recs.push({ text: el.textContent.trim(), t });
    }
    if (w.__sf.liveAt === null) {
      const s = document.querySelector('[data-testid=ws-status]');
      if (s && s.textContent.trim() === 'live') w.__sf.liveAt = t;
    }
  };
  const start = () =>
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
}

const browser = await chromium.launch({ executablePath, headless: true });
const result = { at: new Date().toISOString(), chromium: executablePath };
let exitCode = 0;
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const pageErrors = [];
/** Browser-side trail (sockets, navigations, failed requests), printed only when the gate fails. */
const trail = [];
const note = (s) => trail.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console: ${m.text()}`));
page.on('framenavigated', (f) => f === page.mainFrame() && note(`navigated ${f.url()}`));
page.on('requestfailed', (r) => note(`request failed ${r.url()} ${r.failure()?.errorText}`));
page.on('websocket', (ws) => {
  note(`ws open ${ws.url()}`);
  ws.on('socketerror', (e) => note(`ws error ${ws.url()} ${e}`));
  ws.on('close', () => note(`ws close ${ws.url()}`));
});
try {
  await page.addInitScript(probe);

  // Warm the dev server (on-demand compile) before the run exists.
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  step('web warmed');

  // --- run 1: started by the CLI from inside the linked repo (context resolution) ---
  const stamp = Date.now();
  const started = JSON.parse(
    await sf([
      'run',
      'start',
      '--agent',
      'fake',
      '--title',
      `Gate local ${stamp}`,
      '--prompt',
      'gate turn one',
      '--json',
    ]),
  );
  const runId = started.id;
  step(`sf run start → ${runId} (${started.state})`);
  await page.goto(`${BASE}/runs/${runId}`);
  await page.getByTestId('ws-status').filter({ hasText: 'live' }).waitFor();
  const liveAt = await page.evaluate(() => /** @type {any} */ (window).__sf.liveAt);
  step('run page live');
  await page.getByTestId('assistant').first().waitFor({ timeout: 30_000 });
  await page.locator('[data-testid=tool][data-tool=Bash]').first().waitFor();
  step('transcript streaming (assistant + tool)');
  await page.locator('[data-testid=diff-snapshot][data-turn="1"]').waitFor({ timeout: 30_000 });
  const diff1 = (await events(runId)).find((e) => e.type === 'diff.snapshot');
  assert(diff1 && diff1.emittedAt > liveAt, 'turn-1 diff was not delivered live');
  assert(
    (await page.locator('[data-testid=diff-snapshot][data-turn="1"]').innerText()).includes(
      'gate.md',
    ),
    'turn-1 diff does not show gate.md',
  );
  step('turn-1 diff live');
  await page.locator('[data-testid=run-pr]').waitFor({ timeout: 30_000 });
  await waitFor(async () => (await api('run.get', { id: runId })).state === 'review', 'review');
  step('review + PR link');

  // --- follow-up from the browser (resumes the session on the review run) ---
  const followText = 'gate follow-up from the browser';
  const box = page.getByTestId('follow-up').getByRole('textbox');
  await box.fill(followText);
  await box.press('Control+Enter');
  await page.getByTestId('user-message').filter({ hasText: followText }).waitFor();
  step('follow-up sent from the page');
  await page.locator('[data-testid=diff-snapshot][data-turn="2"]').waitFor({ timeout: 30_000 });
  assert(
    (await page.locator('[data-testid=diff-snapshot][data-turn="2"]').innerText()).includes(
      followText,
    ),
    'turn-2 diff does not contain the follow-up',
  );
  step('turn-2 diff live');
  const final = await waitFor(async () => {
    const r = await api('run.get', { id: runId });
    const evs = await events(runId);
    const lastState = evs.findLast((e) => e.type === 'run.state');
    const msgSeq = evs.find((e) => e.type === 'user.message')?.seq ?? Infinity;
    return r.state === 'review' && lastState.seq > msgSeq ? { r, evs } : undefined;
  }, 'second review');
  assert(final.r.prUrl?.startsWith('https://github.com/sf-gate/'), `prUrl: ${final.r.prUrl}`);
  assert(
    final.evs.some((e) => e.type === 'pr.opened'),
    'no pr.opened event',
  );
  await page.locator('[data-state=review]').first().waitFor();
  step(`run ended review, prUrl ${final.r.prUrl}`);

  // --- git: commits on the task branch, made in the task worktree ---
  const { tasks } = await api('task.list', { projectId: args.project });
  const task = tasks.find((t) => t.id === final.r.taskId);
  const wt = join(args.data, 'worktrees', args.project, task.id);
  assert(existsSync(join(wt, 'gate.md')), `no gate.md in worktree ${wt}`);
  const body = await git(['log', '-1', '--format=%B', task.branch]);
  assert(body.includes(`sf run ${runId}`), `no commit for ${runId} on ${task.branch}: ${body}`);
  const ahead = Number(await git(['rev-list', '--count', `main..${task.branch}`]));
  assert(ahead === 2, `expected 2 commits on ${task.branch}, got ${ahead}`);
  assert((await git(['status', '--porcelain'])) === '', 'main checkout was modified');
  step(`${ahead} commits on ${task.branch}`);

  // --- latency: daemon emittedAt → DOM, for the follow-up turn (page certainly live) ---
  const msgSeq = final.evs.find((e) => e.type === 'user.message').seq;
  const emitted = new Map();
  for (const e of final.evs) {
    const text = e.payload?.text;
    if (
      e.seq > msgSeq &&
      e.type === 'agent' &&
      e.payload.type === 'message' &&
      /^lat-\d+ /.test(text)
    )
      emitted.set(text, e.emittedAt);
  }
  const recs = await page.evaluate(() => /** @type {any} */ (window).__sf.recs);
  const lat = recs.filter((r) => emitted.has(r.text)).map((r) => r.t - emitted.get(r.text));
  assert(lat.length >= 36, `latency: matched only ${lat.length}/40 burst messages`);
  assert(
    lat.every((x) => x > -5),
    `latency: negative sample (clock?) ${Math.min(...lat)}`,
  );
  result['local-agent-event-to-gui'] = {
    p50: r1(pct(lat, 50)),
    p95: r1(pct(lat, 95)),
    n: lat.length,
  };
  step(`event→GUI p50 ${r1(pct(lat, 50))} ms, p95 ${r1(pct(lat, 95))} ms (n=${lat.length})`);

  // --- run 2: sf run cancel → abandoned ---
  const second = JSON.parse(
    await sf([
      'run',
      'start',
      '--agent',
      'fake',
      '--title',
      `Gate cancel ${stamp}`,
      '--prompt',
      'gate cancel me',
      '--json',
    ]),
  );
  await waitFor(
    async () => (await events(second.id)).some((e) => e.payload?.type === 'session.started'),
    'second run agent start',
  );
  await sf(['run', 'cancel', second.id]);
  const tc = Date.now();
  await waitFor(
    async () => (await api('run.get', { id: second.id })).state === 'abandoned',
    'abandoned',
    10_000,
  );
  step(`sf run cancel → abandoned in ${Date.now() - tc} ms`);

  // --- route change: sidebar navigation between two loaded pages ---
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  const nav = (label, title) =>
    page.evaluate(
      ([label, title]) =>
        new Promise((resolve) => {
          const a = [...document.querySelectorAll('a')].find((x) => x.textContent.trim() === label);
          const t = performance.now();
          a.click();
          const check = () => {
            const h = document.querySelector('h1');
            if (h?.textContent === title && !document.querySelector('[data-slot=skeleton]'))
              requestAnimationFrame(() => resolve(performance.now() - t));
            else requestAnimationFrame(check);
          };
          check();
        }),
      [label, title],
    );
  await nav('Projects', 'Projects'); // first visit loads the route chunk
  await nav('Needs you', 'Needs you');
  const routes = [];
  for (let i = 0; i < 10; i++) {
    routes.push(await nav('Projects', 'Projects'));
    routes.push(await nav('Needs you', 'Needs you'));
  }
  result['route-change'] = { p50: r1(pct(routes, 50)), p95: r1(pct(routes, 95)), n: routes.length };
  step(`route change p50 ${r1(pct(routes, 50))} ms, p95 ${r1(pct(routes, 95))} ms`);

  // --- GUI first load, warm cache: reload / until the load event ---
  const loads = [];
  for (let i = 0; i < 6; i++) {
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.getByRole('heading', { name: 'Needs you' }).waitFor();
    const nt = await page.evaluate(() => {
      const n = /** @type {PerformanceNavigationTiming} */ (
        performance.getEntriesByType('navigation')[0]
      );
      return n.loadEventEnd - n.startTime;
    });
    if (i > 0) loads.push(nt); // first one warms
  }
  result['gui-first-load-warm'] = {
    p50: r1(pct(loads, 50)),
    p95: r1(pct(loads, 95)),
    n: loads.length,
  };
  step(`first load (warm) p50 ${r1(pct(loads, 50))} ms, p95 ${r1(pct(loads, 95))} ms`);

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);

  // --- budgets ---
  const config = JSON.parse(readFileSync(join(root, 'perf-budget.json'), 'utf8'));
  for (const id of ['local-agent-event-to-gui', 'route-change', 'gui-first-load-warm']) {
    const b = config.budgets.find((x) => x.id === id);
    const ok = result[id].p95 <= b.budget;
    if (!ok) exitCode = 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${id}: p95 ${result[id].p95} ms (budget ${b.budget})`);
  }
  mkdirSync(join(root, '.perf'), { recursive: true });
  writeFileSync(join(root, '.perf/gate-local.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (exitCode) console.error('gate:local: perf budget exceeded');
} catch (e) {
  console.error(`gate:local: ${e instanceof Error ? e.message : String(e)}`);
  exitCode = 1;
  // Evidence for CI, where the failure can't be reproduced interactively.
  const out = join(root, '.perf');
  mkdirSync(out, { recursive: true });
  console.error(`--- page url ${page.url()}`);
  const status = await page
    .getByTestId('ws-status')
    .textContent({ timeout: 1000 })
    .catch(() => '(none)');
  console.error(`--- ws-status ${status}`);
  if (pageErrors.length) console.error(`--- page errors\n${pageErrors.join('\n')}`);
  console.error(`--- browser trail\n${trail.slice(-40).join('\n')}`);
  await page
    .screenshot({ path: join(out, 'gate-local-failure.png'), fullPage: true })
    .catch(() => {});
  writeFileSync(join(out, 'gate-local-failure.html'), await page.content().catch(() => ''));
} finally {
  await browser.close();
}
process.exit(exitCode);
