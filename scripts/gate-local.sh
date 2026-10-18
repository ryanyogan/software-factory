#!/usr/bin/env bash
# Phase 1 technical gate (`pnpm gate:local`): the local loop end to end, in a real browser.
#   pnpm dev (temp D1/DO state) + `sf daemon --pr-provider fake` (temp SF_CONFIG_DIR / XDG_DATA_HOME)
#   + a temp git repo with a GitHub-style origin (never pushed) → `sf link` → `sf run start --agent fake`
#   from inside the repo → headless chromium watches the run page (transcript + turn-1 diff live),
#   sends a follow-up from the page → turn-2 diff → review + prUrl + commit on the task branch;
#   `sf run cancel` on a second run → abandoned. Also measures the latency budgets (scripts/gate-local.mjs).
# Needs chromium: SF_CHROMIUM=<path>, /usr/bin/chromium(-browser), google-chrome, or
# `pnpm exec playwright-core install chromium`. Without one it FAILS (never skips).
# Everything it starts runs in its own process group and is killed on exit; temp dirs are deleted
# (SF_GATE_KEEP=1 keeps them for debugging).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

BASE="http://localhost:5173"
TMP="$(mktemp -d -t sf-gate-local.XXXXXX)"
export SF_STATE_DIR="$TMP/state" SF_CONFIG_DIR="$TMP/config" XDG_DATA_HOME="$TMP/xdg"
export SF_API_URL="$BASE" SF_NO_BROWSER=1
unset SF_DATA_DIR SF_PR_PROVIDER SF_FAKE_SCRIPT
REPO="$TMP/repo"
SF=(node "$ROOT/apps/cli/dist/cli.mjs")
PGIDS=()

say() { printf '\033[1m[gate:local]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[gate:local] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }
cleanup() {
  local code=$?
  for pg in "${PGIDS[@]}"; do kill -TERM -- "-$pg" 2>/dev/null || true; done
  for pg in "${PGIDS[@]}"; do
    for _ in $(seq 1 40); do kill -0 -- "-$pg" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pg" 2>/dev/null || true
  done
  if [[ $code -ne 0 ]]; then
    for f in dev daemon; do
      [[ -f "$TMP/$f.log" ]] && { echo "--- $f.log (tail)" >&2; tail -25 "$TMP/$f.log" >&2; }
    done
  fi
  if [[ -n "${SF_GATE_KEEP:-}" ]]; then say "kept $TMP"; else rm -rf "$TMP"; fi
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Start "$@" in a new session (own process group) with output to $1.log; records the pgid.
spawn() { local log="$TMP/$1.log"; shift; setsid "$@" >"$log" 2>&1 & PGIDS+=("$!"); }
wait_log() { # file pattern seconds pgid
  for _ in $(seq 1 $(($3 * 4))); do
    grep -q "$2" "$1" 2>/dev/null && return 0
    kill -0 -- "-$4" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=process.argv[1].split(".").reduce((o,k)=>o?.[k],v);if(r===undefined)process.exit(1);console.log(typeof r==="string"?r:JSON.stringify(r))})' "$1"; }
port_in_use() { node -e 'const s=require("net").connect(+process.argv[1],"localhost");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1))' "$1"; }

port_in_use 5173 && fail "port 5173 is in use; stop it first so the gate owns the server"
node scripts/gate-local.mjs --check-browser || fail "no chromium found (see the header of scripts/gate-local.sh)"
[[ -f apps/cli/dist/cli.mjs ]] || { say "building CLI"; pnpm -s --filter @sf/cli build >/dev/null; }

say "migrating a temp D1 state dir"
mkdir -p "$SF_STATE_DIR" "$SF_CONFIG_DIR" "$XDG_DATA_HOME"
pnpm -s db:migrate:local >/dev/null

say "starting pnpm dev"
T0=$(date +%s%N)
spawn dev pnpm dev
DEV_PG="${PGIDS[-1]}"
for i in $(seq 1 240); do
  curl -sf "$BASE/v1/health" >/dev/null 2>&1 && break
  kill -0 -- "-$DEV_PG" 2>/dev/null || fail "dev server exited"
  [[ $i == 240 ]] && fail "dev server not healthy after 60s"
  sleep 0.25
done
say "dev healthy in $((($(date +%s%N) - T0) / 1000000)) ms"

STAMP="$(date +%s)"
say "temp repo $REPO (origin git@github.com:sf-gate/local-$STAMP.git, never pushed)"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.name=gate -c user.email=gate@localhost commit -q --allow-empty -m init
echo "# gate" >"$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" -c user.name=gate -c user.email=gate@localhost commit -q -m readme
git -C "$REPO" remote add origin "git@github.com:sf-gate/local-$STAMP.git"
git -C "$REPO" config user.name gate
git -C "$REPO" config user.email gate@localhost

PROJECT_ID="$("${SF[@]}" project create --name "gate-local-$STAMP" --repo "https://github.com/sf-gate/local-$STAMP" --json | json id)" || fail "project create"
(cd "$REPO" && "${SF[@]}" link >/dev/null) || fail "sf link"

say "starting sf daemon --pr-provider fake"
export SF_FAKE_SCRIPT="$ROOT/scripts/gate-local.fake.json"
spawn daemon "${SF[@]}" daemon --pr-provider fake
DAEMON_PG="${PGIDS[-1]}"
unset SF_FAKE_SCRIPT
wait_log "$TMP/daemon.log" "room $PROJECT_ID connected" 20 "$DAEMON_PG" || fail "daemon did not connect to the project room"

say "browser driver"
setsid node scripts/gate-local.mjs --base "$BASE" --repo "$REPO" --project "$PROJECT_ID" \
  --cli "$ROOT/apps/cli/dist/cli.mjs" --data "$XDG_DATA_HOME/sf" &
DRIVER=$!
PGIDS+=("$DRIVER")
wait "$DRIVER" || fail "browser driver"

say "stopping the daemon"
kill -TERM -- "-$DAEMON_PG" 2>/dev/null || true
wait_log "$TMP/daemon.log" "stopped" 20 "$DAEMON_PG" || true
say "PASS"
