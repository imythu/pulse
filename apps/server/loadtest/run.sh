#!/usr/bin/env bash
# M2 压测一键运行：构建好的后端 + 1 台真实 Agent（故障风暴）+ N 台模拟 Agent。
#
#   LOAD_DATABASE_URL=postgres://pulse:pulse@127.0.0.1/pulse_load ./loadtest/run.sh
#
# 环境变量：AGENTS（默认 500）、MINUTES（默认 30）、LINES（默认 100000）、OUT（结果目录，默认 /tmp/pulse-load）。
# 会清空 LOAD_DATABASE_URL 指向的库。
set -euo pipefail
cd "$(dirname "$0")/.."
export no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}" NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"

: "${LOAD_DATABASE_URL:?需要 LOAD_DATABASE_URL}"
AGENTS="${AGENTS:-500}"
MINUTES="${MINUTES:-30}"
LINES="${LINES:-100000}"
OUT="${OUT:-/tmp/pulse-load}"
PORT="${PORT:-18080}"
SERVER="http://127.0.0.1:$PORT"
AGENT_BIN="../agent/bin/pulse-agent-linux-amd64"

rm -rf "$OUT" && mkdir -p "$OUT/agent"
psql "$LOAD_DATABASE_URL" -qc 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

DATABASE_URL="$LOAD_DATABASE_URL" PORT=$PORT PULSE_PUBLIC_URL="$SERVER" LOG_LEVEL=warn \
  node dist/main.js >"$OUT/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID ${AGENT_PID:-} 2>/dev/null || true' EXIT
until curl -sf "$SERVER/healthz" >/dev/null; do sleep 0.5; done

# 初始化管理员，给真实 Agent 生成注册令牌
curl -sf -c "$OUT/cookie" -H 'content-type: application/json' \
  -d '{"username":"admin","password":"loadtest-password"}' "$SERVER/api/v1/setup" >/dev/null
TOKEN=$(curl -sf -b "$OUT/cookie" -H 'content-type: application/json' -d '{"labels":{"service":"order-api"}}' \
  "$SERVER/api/v1/agents/enroll-tokens" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

cat >"$OUT/agent.yaml" <<EOF
server: $SERVER
data_dir: $OUT/agent
logs:
  journald:
    enabled: false
  files:
    - service: order-api
      paths: [$OUT/order-api.log]
EOF
touch "$OUT/order-api.log"
"$AGENT_BIN" enroll --config "$OUT/agent.yaml" --token "$TOKEN"
"$AGENT_BIN" run --config "$OUT/agent.yaml" >"$OUT/agent.log" 2>&1 &
AGENT_PID=$!

npx tsx loadtest/sim.ts --server "$SERVER" --agents "$AGENTS" --minutes "$((MINUTES + 2))" \
  --pids "$SERVER_PID,pg" --out "$OUT/sim.json" >"$OUT/sim.log" 2>&1 &
SIM_PID=$!
# 等模拟 Agent 全部连上后再开始风暴
sleep 90
npx tsx loadtest/storm.ts --server "$SERVER" --log "$OUT/order-api.log" --hostname "$(hostname)" \
  --minutes "$MINUTES" --lines "$LINES" --out "$OUT/storm.json" >"$OUT/storm.log" 2>&1 &
STORM_PID=$!

# 采样真实 Agent 自身的资源占用
( while kill -0 $AGENT_PID 2>/dev/null; do
    # 时间戳、常驻内存 KB、累计 CPU 时钟数（utime+stime）
    echo "$(date +%s) $(awk '/VmRSS/{print $2}' /proc/$AGENT_PID/status) $(awk '{print $14+$15}' /proc/$AGENT_PID/stat)" >>"$OUT/agent-usage.txt" || true
    sleep 30
  done ) &

STORM_STATUS=0
wait $STORM_PID || STORM_STATUS=$?
wait $SIM_PID || true
echo "storm exit=$STORM_STATUS，结果在 $OUT"
exit $STORM_STATUS
