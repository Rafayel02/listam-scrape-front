#!/usr/bin/env bash
# Pull latest scrape-front code and restart the Vite dev server.
#
# Prefer launchd on macOS (cron cannot reliably access Desktop):
#   cp scripts/com.listam.scrape-front.pull-and-restart.plist ~/Library/LaunchAgents/
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.listam.scrape-front.pull-and-restart.plist
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

log "Pull and restart v3 — $SCRAPER_DIR"

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
  log "No code changes — server left running"
  exit 0
fi

log "Updated to $(git -C "$SCRAPER_DIR" log -1 --oneline)"

if git -C "$SCRAPER_DIR" diff --name-only "$OLD_HEAD" "$NEW_HEAD" | grep -qE '(^|/)package(-lock)?\.json$'; then
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
