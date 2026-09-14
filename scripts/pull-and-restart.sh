#!/usr/bin/env bash
# Pull latest scrape-front code and restart the Vite dev server.
#
# Prefer launchd on macOS (cron cannot reliably access Desktop):
#   ./scripts/install-launchd.sh
#
# Or manually:
#   ./scripts/pull-and-restart.sh

set -euo pipefail

export HOME="${HOME:-$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')}"
export HOME="${HOME:-/Users/$(id -un)}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o IdentitiesOnly=yes}"

SCRAPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRAPER_DIR"

PORT=5174
RUN_DIR="${SCRAPER_DIR}/.run"
LOG_FILE="${RUN_DIR}/pull-and-restart.log"
DEV_LOG="${RUN_DIR}/dev.log"
PID_FILE="${RUN_DIR}/dev.pid"
API_STATUS="http://127.0.0.1:${PORT}/api/dev/browser/status"
DEV_LABEL="com.listam.scrape-front.dev-server"
UID_NUM="$(id -u)"

mkdir -p "$RUN_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

is_scraping() {
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  local body
  body="$(curl -sf --max-time 3 "$API_STATUS" 2>/dev/null || true)"
  [[ "$body" == *'"scrapingEnabled":true'* ]]
}

# Healthy only if something is actually listening on the Vite port.
server_running() {
  command -v lsof >/dev/null 2>&1 && lsof -ti:"$PORT" >/dev/null 2>&1
}

port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:"$PORT" 2>/dev/null || true
  fi
}

stop_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      log "Stopping tracked pid $pid"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi

  local pids
  pids="$(port_pids)"
  if [[ -n "$pids" ]]; then
    log "Freeing port $PORT"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

wait_for_port() {
  local tries="${1:-40}"
  local i
  for ((i = 1; i <= tries; i++)); do
    if server_running; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

record_listener_pid() {
  local pids
  pids="$(port_pids)"
  if [[ -n "$pids" ]]; then
    # Prefer the first listener pid for tracking.
    echo "$pids" | awk 'NR==1{print; exit}' >"$PID_FILE"
  fi
}

start_via_launchd() {
  if ! launchctl print "gui/${UID_NUM}/${DEV_LABEL}" >/dev/null 2>&1; then
    return 1
  fi
  log "Restarting launchd ${DEV_LABEL} (KeepAlive)"
  # Kill + respawn so Vite picks up pulled code.
  launchctl kickstart -k "gui/${UID_NUM}/${DEV_LABEL}" 2>/dev/null || \
    launchctl kill SIGTERM "gui/${UID_NUM}/${DEV_LABEL}" 2>/dev/null || true
  return 0
}

start_via_nohup() {
  log "Starting dev server via nohup on port $PORT"
  # Detach fully so the process survives the LaunchAgent pull job exiting.
  (
    cd "$SCRAPER_DIR"
    exec nohup npm run dev >>"$DEV_LOG" 2>&1
  ) >/dev/null 2>&1 &
  echo $! >"$PID_FILE"
  disown "$!" 2>/dev/null || true
  log "Spawned pid $(cat "$PID_FILE") — logs: $DEV_LOG"
}

start_server() {
  if ! command -v npm >/dev/null 2>&1; then
    log "npm not found in PATH"
    exit 1
  fi

  : >>"$DEV_LOG"
  if start_via_launchd; then
    :
  else
    start_via_nohup
  fi

  if wait_for_port 40; then
    record_listener_pid
    log "Dev server is listening on port $PORT (pid $(cat "$PID_FILE" 2>/dev/null || echo '?'))"
    return 0
  fi

  log "Dev server failed to bind port $PORT — retrying after npm install"
  stop_server
  npm install 2>&1 | tee -a "$LOG_FILE"

  if start_via_launchd; then
    :
  else
    start_via_nohup
  fi

  if wait_for_port 40; then
    record_listener_pid
    log "Dev server is listening on port $PORT (pid $(cat "$PID_FILE" 2>/dev/null || echo '?'))"
    return 0
  fi

  log "Dev server still not listening — last log lines:"
  tail -40 "$DEV_LOG" 2>/dev/null | tee -a "$LOG_FILE" || true
  exit 1
}

ensure_server_running() {
  if server_running; then
    record_listener_pid
    log "Dev server already listening on port $PORT"
    return 0
  fi
  log "Dev server was not listening on port $PORT — starting"
  start_server
}

log "Pull and restart v6 — $SCRAPER_DIR"

if ! OLD_HEAD="$(git -C "$SCRAPER_DIR" rev-parse HEAD 2>>"$LOG_FILE")"; then
  log "git rev-parse failed (macOS may be blocking access to this folder — keep the repo off Desktop/Documents)"
  exit 1
fi

pull_out="$(mktemp)"
if ! git -C "$SCRAPER_DIR" pull --ff-only >"$pull_out" 2>&1; then
  cat "$pull_out" | tee -a "$LOG_FILE"
  rm -f "$pull_out"
  log "git pull failed"
  exit 1
fi
cat "$pull_out" | tee -a "$LOG_FILE"
rm -f "$pull_out"

NEW_HEAD="$(git -C "$SCRAPER_DIR" rev-parse HEAD)"

if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
  log "No code changes"
  ensure_server_running
  exit 0
fi

log "Updated to $(git -C "$SCRAPER_DIR" log -1 --oneline)"

if git -C "$SCRAPER_DIR" diff --name-only "$OLD_HEAD" "$NEW_HEAD" | grep -qE '(^|/)package(-lock)?\.json$'; then
  log "Dependencies changed — running npm install"
  npm install 2>&1 | tee -a "$LOG_FILE"
fi

if is_scraping; then
  log "Scrape in progress — restart deferred until next run"
  ensure_server_running
  exit 0
fi

if server_running; then
  stop_server
else
  log "Dev server was not listening"
fi

start_server
