#!/usr/bin/env bash
# One command for the hardware session: starts the production server and one HTTPS tunnel with an access key,
# prints the three URLs to open, appends evidence rows, and stops only what it started.
#
#   bash scripts/hw-session.sh start          # server + tunnel, prints URLs (SPOTTER=1 turns the dose finder on)
#   bash scripts/hw-session.sh urls           # print the URLs again
#   bash scripts/hw-session.sh probe "H1"     # append one evidence row to docs/HARDWARE_LOG.md
#   bash scripts/hw-session.sh stop           # stop the server and tunnel started by `start`
set -euo pipefail
cd "$(dirname "$0")/.."
STATE="${HOLDUP_HW_STATE:-/tmp/holdup-hw}"
PORT="${PORT:-8787}"
mkdir -p "$STATE"

urls() {
  local url key
  url="$(cat "$STATE/url" 2>/dev/null || true)"; key="$(cat "$STATE/key" 2>/dev/null || true)"
  [ -n "$url" ] || { echo "No tunnel URL yet. Run: bash scripts/hw-session.sh start"; exit 1; }
  echo
  echo "  Phone (Chrome on the Android phone):   $url/?key=$key"
  echo "  Bridge app, Server URL field:          $url/?key=$key"
  echo "  Display Web App (Meta AI app):         $url/hud/?key=$key"
  echo "  Projector view (laptop browser):       $url/stage?key=$key"
  echo "  Health:                                $url/api/health"
  echo
  echo "  Keep this tunnel running: a new one means re-entering every URL."
}

case "${1:-}" in
  start)
    [ -f .env ] || { echo "No .env here. Copy .env.example to .env and add GEMINI_API_KEY."; exit 1; }
    if [ -f "$STATE/server.pid" ] && kill -0 "$(cat "$STATE/server.pid")" 2>/dev/null; then echo "Already running."; urls; exit 0; fi
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $PORT is in use by another program. Stop it, or run with PORT=8788."; exit 1; fi
    command -v cloudflared >/dev/null || { echo "cloudflared is not installed (brew install cloudflared)."; exit 1; }
    # access key: HOLDUP_KEY from the environment or .env, otherwise a fresh one for this session
    KEY="${HOLDUP_KEY:-$(grep -E '^HOLDUP_KEY=.' .env 2>/dev/null | head -1 | cut -d= -f2- || true)}"
    [ -n "$KEY" ] || KEY="$(openssl rand -hex 6)"
    umask 077; printf '%s' "$KEY" > "$STATE/key"
    echo "Building the app..."
    npm run build >"$STATE/build.log" 2>&1 || { echo "Build failed, see $STATE/build.log"; exit 1; }
    HOLDUP_KEY="$KEY" SPOTTER="${SPOTTER:-0}" PORT="$PORT" nohup npm -w server run start >"$STATE/server.log" 2>&1 &
    echo $! > "$STATE/server.pid"
    for _ in $(seq 1 40); do curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 || { echo "Server did not start, see $STATE/server.log"; exit 1; }
    nohup cloudflared tunnel --url "http://localhost:$PORT" >"$STATE/tunnel.log" 2>&1 &
    echo $! > "$STATE/tunnel.pid"
    URL=""
    for _ in $(seq 1 40); do URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/tunnel.log" | head -1 || true)"; [ -n "$URL" ] && break; sleep 1; done
    [ -n "$URL" ] || { echo "Tunnel did not come up, see $STATE/tunnel.log"; exit 1; }
    printf '%s' "$URL" > "$STATE/url"
    echo "Server and tunnel are up (dose finder: $([ "${SPOTTER:-0}" = 1 ] && echo on || echo off)). Gemini: $(curl -fsS "http://localhost:$PORT/api/health" | grep -o '"gemini":"[a-z]*"' || true)"
    urls
    ;;
  urls) urls ;;
  probe)
    LABEL="${2:-probe}"
    HOLDUP_KEY="$(cat "$STATE/key" 2>/dev/null || true)" npm -w server run --silent hw:probe -- --base "http://localhost:$PORT" --label "$LABEL"
    ;;
  stop)
    for name in tunnel server; do
      f="$STATE/$name.pid"
      if [ -f "$f" ]; then
        pid="$(cat "$f")"
        # stop the children this script's process started, then the process itself; nothing else is touched
        pkill -TERM -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
        rm -f "$f"
        echo "Stopped $name ($pid)."
      fi
    done
    ;;
  *) sed -n 2,8p "$0"; exit 1 ;;
esac
