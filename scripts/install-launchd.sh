#!/usr/bin/env bash
# Install/refresh LaunchAgents for scrape-front deploy + KeepAlive Vite server.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

mkdir -p "$REPO/.run" "$AGENTS"

install_agent() {
  local name="$1"
  local src="$REPO/scripts/${name}.plist"
  local dst="$AGENTS/${name}.plist"
  cp "$src" "$dst"
  launchctl bootout "gui/${UID_NUM}/${name}" 2>/dev/null || true
  launchctl bootstrap "gui/${UID_NUM}" "$dst"
  echo "installed ${name}"
}

install_agent com.listam.scrape-front.pull-and-restart
install_agent com.listam.scrape-front.dev-server

launchctl kickstart -k "gui/${UID_NUM}/com.listam.scrape-front.dev-server"
echo "dev-server kickstarted"
