#!/usr/bin/env bash
# Pull latest scrape-front code and restart the Vite dev server.
#
# Usage (every 5 minutes via cron / launchd):
#   */5 * * * * /path/to/scrape-front/scripts/pull-and-restart.sh
#
# Or manually:
#   ./scripts/pull-and-restart.sh

set -euo pipefail

SCRAPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRAPER_DIR"

PORT=5174
RUN_DIR="${SCRAPER_DIR}/.run"
LOG_FILE="${RUN_DIR}/pull-and-restart.log"
DEV_LOG="${RUN_DIR}/dev.log"
PID_FILE="${RUN_DIR}/dev.pid"
API_STATUS="http://127.0.0.1:${PORT}/api/dev/browser/status"

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

server_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  if command -v lsof >/dev/null 2>&1 && lsof -ti:"$PORT" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

stop_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      log "Stopping dev server (pid $pid)"
      kill "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi

  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti:"$PORT" 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      log "Freeing port $PORT"
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

start_server() {
  if ! command -v npm >/dev/null 2>&1; then
    log "npm not found in PATH"
    exit 1
  fi

  log "Starting dev server on port $PORT"
  nohup npm run dev >>"$DEV_LOG" 2>&1 &
  echo $! >"$PID_FILE"
  log "Dev server pid $(cat "$PID_FILE") — logs: $DEV_LOG"
}

log "Pull and restart — $SCRAPER_DIR"

OLD_HEAD="$(git rev-parse HEAD)"
if ! git pull --ff-only 2>&1 | tee -a "$LOG_FILE"; then
  log "git pull failed"
  exit 1
fi
NEW_HEAD="$(git rev-parse HEAD)"

if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
  log "No code changes — server left running"
  exit 0
fi

log "Updated to $(git log -1 --oneline)"

if git diff --name-only "$OLD_HEAD" "$NEW_HEAD" | grep -qE '(^|/)package(-lock)?\.json$'; then
  log "Dependencies changed — running npm install"
  npm install 2>&1 | tee -a "$LOG_FILE"
fi

if is_scraping; then
  log "Scrape in progress — restart deferred until next run"
  exit 0
fi

if server_running; then
  stop_server
else
  log "Dev server was not running"
fi

start_server
