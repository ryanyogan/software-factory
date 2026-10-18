#!/usr/bin/env bash
# Phase 0 gate: the `sf` CLI and the web GUI go through ONE API.
#   CLI (HTTP POST /v1/commands/*)  → project.create → task.create → run.start
#   GUI (SSR loader → createServerFn → service-binding RPC ApiRpc.command) → /tasks/<id> must list the run
# Starts `pnpm dev` (http://localhost:5173) on a throwaway D1/DO state dir (SF_STATE_DIR, migrated first),
# so the developer's dev database is never touched. Stops the server and deletes the state on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${SF_GATE_URL:-http://localhost:5173}"
LOG="$(mktemp -t sf-gate-dev.XXXXXX.log)"
export SF_STATE_DIR="$(mktemp -d -t sf-gate-state.XXXXXX)"
SF=(node apps/cli/dist/cli.mjs --api "$BASE")
DEV_PID=""

say() { printf '\033[1m[gate]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[gate] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }
cleanup() {
  local code=$?
  if [[ -n "$DEV_PID" ]]; then
    say "stopping dev server (pgid $DEV_PID)"
    kill -TERM -- "-$DEV_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 -- "-$DEV_PID" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$DEV_PID" 2>/dev/null || true
  fi
  rm -rf "$SF_STATE_DIR"
  [[ $code -eq 0 ]] && rm -f "$LOG"
  exit $code
}
trap cleanup EXIT INT TERM
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=process.argv[1].split(".").reduce((o,k)=>o?.[k],v);if(r===undefined)process.exit(1);console.log(typeof r==="string"?r:JSON.stringify(r))})' "$1"; }

port_in_use() { node -e 'const s=require("net").connect(+process.argv[1],"localhost");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1))' "$1"; }
port_in_use 5173 && fail "port 5173 is in use; stop it first so the gate owns the server"

say "applying D1 migrations to a temp state dir ($SF_STATE_DIR)"
pnpm -s db:migrate:local >/dev/null

if [[ ! -f apps/cli/dist/cli.mjs ]]; then
  say "building CLI"
  pnpm -s --filter @sf/cli build >/dev/null
fi

say "starting pnpm dev (log: $LOG)"
setsid pnpm dev >"$LOG" 2>&1 &
DEV_PID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/v1/health" >/dev/null 2>&1 && break
  kill -0 "$DEV_PID" 2>/dev/null || { tail -20 "$LOG" >&2; fail "dev server exited"; }
  [[ $i == 60 ]] && fail "dev server not healthy after 60s"
  sleep 1
done

STAMP="$(date +%s)"
say "CLI: project create"
PROJECT_ID="$("${SF[@]}" project create --name "gate-$STAMP" --repo "https://github.com/acme/gate" --json | json id)" || fail "project create"
say "CLI: task create ($PROJECT_ID)"
TASK_ID="$("${SF[@]}" task create --project "$PROJECT_ID" --title "Gate task $STAMP" --json | json id)" || fail "task create"
say "CLI: run start ($TASK_ID)"
RUN_JSON="$("${SF[@]}" run start --task "$TASK_ID" --agent claude-code --location local --prompt "Gate prompt $STAMP" --json)"
RUN_ID="$(json id <<<"$RUN_JSON")" || fail "run start: $RUN_JSON"
[[ "$(json state <<<"$RUN_JSON")" == "queued" ]] || fail "run not queued: $RUN_JSON"

say "CLI: run list --task $TASK_ID"
"${SF[@]}" run list --task "$TASK_ID" --json | grep -q "\"$RUN_ID\"" || fail "CLI run list missing $RUN_ID"

say "API: run.claim twice (second must be 409 conflict)"
claim() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data "{\"id\":\"$RUN_ID\",\"machineId\":\"$1\"}" "$BASE/v1/commands/run.claim"; }
[[ "$(claim mch_gate_a)" == "200" ]] || fail "first run.claim did not succeed"
[[ "$(claim mch_gate_b)" == "409" ]] || fail "second run.claim was not a 409 conflict"

say "GUI: GET $BASE/tasks/$TASK_ID (SSR → server fn → ApiRpc)"
HTML="$(curl -sf "$BASE/tasks/$TASK_ID")" || fail "task page request failed"
grep -q "$RUN_ID" <<<"$HTML" || fail "web task page does not list run $RUN_ID"

say "PASS: run $RUN_ID created via CLI is listed by the web GUI (one API)"
