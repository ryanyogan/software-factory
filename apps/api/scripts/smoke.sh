#!/usr/bin/env bash
# Curl smoke test against a running `pnpm --filter @sf/api dev` (wrangler dev on :8787) with
# SF_DEV_AUTH=1 in .dev.vars. Usage: apps/api/scripts/smoke.sh [base-url]
set -euo pipefail
BASE="${1:-http://localhost:8787}"

call() { # name json -> prints body, fails on non-2xx
  curl -sS --fail-with-body -X POST "$BASE/v1/commands/$1" -H 'content-type: application/json' -d "$2"
}
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

echo "health:      $(curl -sS --fail-with-body "$BASE/v1/health")"
PROJECT=$(call project.create '{"name":"Smoke","repoUrl":"https://github.com/acme/smoke"}' | field id)
echo "project:     $PROJECT"
TASK=$(call task.create "{\"projectId\":\"$PROJECT\",\"title\":\"Smoke task\"}" | field id)
echo "task:        $TASK"
RUN=$(call run.start "{\"taskId\":\"$TASK\",\"agent\":\"claude-code\"}" | field id)
echo "run:         $RUN"
COUNT=$(call run.list "{\"taskId\":\"$TASK\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).runs.length))')
[ "$COUNT" = 1 ] || { echo "run.list expected 1 run, got $COUNT"; exit 1; }
echo "run.list:    $COUNT run"

STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/commands/nope" -d '{}')
[ "$STATUS" = 404 ] || { echo "unknown command expected 404, got $STATUS"; exit 1; }
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/commands/task.create" -d '{}')
[ "$STATUS" = 400 ] || { echo "invalid input expected 400, got $STATUS"; exit 1; }
echo "errors:      404 unknown_command, 400 invalid_input"

# RunLog replay over WebSocket: the run.started event must be there (Node 22+ global WebSocket).
WS="${BASE/http/ws}/v1/runs/$RUN/events?since=0"
node -e '
const ws = new WebSocket(process.argv[1]);
const t = setTimeout(() => { console.error("no event"); process.exit(1); }, 5000);
ws.onmessage = (m) => { const e = JSON.parse(m.data); if (e.type !== "run.started") process.exit(1);
  console.log("ws replay:   seq=" + e.seq + " " + e.type); clearTimeout(t); ws.close(); process.exit(0); };
ws.onerror = (e) => { console.error("ws error", e.message); process.exit(1); };' "$WS"
echo "smoke OK"
