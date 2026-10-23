#!/usr/bin/env bash
# Start-up smoke test for a built macOS app (U-3, D-062). Runs on a GitHub macOS runner (which has
# a logged-in desktop session) after scripts/release-macos.sh, without a person at a Mac:
#   1. starts the .app through Launch Services (`open`), as a Finder/Dock start would;
#   2. waits for the hub to write port.json and answer GET /v1/health;
#   3. sends a SessionStart through the bundled hook with an almost empty environment (no
#      AGENTHUB_DATA_DIR), so the hook has to find the hub data folder on its own, and checks
#      that the hub lists the session;
#   4. quits the app and checks that no app, hub or hook process is left.
# On failure it prints the app and hub logs.
#
# Usage: ./scripts/macos-smoke.sh <path to Kotilo.app>
set -euo pipefail

app="${1:?usage: macos-smoke.sh <path to .app>}"
[ -d "$app" ] || { echo "app not found: $app" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
json() { node -p "require(process.argv[1])$2" "$1"; }
prefix="$(json "$root/brand.json" .exePrefix)"
slug="$(json "$root/brand.json" .slug)"
data="$HOME/Library/Application Support/$slug"
port_file="$data/hub/port.json"
hook="$app/Contents/MacOS/$prefix-hook"
session="smoke-$(date +%s)-$$"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
fail() {
  printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2
  for dir in "$data/logs" "$data/hub/logs"; do
    for f in "$dir"/*; do
      [ -f "$f" ] || continue
      echo "----- $f (last 80 lines)"
      tail -n 80 "$f"
    done
  done
  echo "----- processes"
  pgrep -fl "$prefix" || true
  exit 1
}
running() { pgrep -f "$app/Contents/MacOS/" > /dev/null 2>&1; }

# A port.json from an earlier run would let the wait below pass before the new hub is up.
rm -f "$port_file"

step "open $app"
open -n "$app" || fail "open failed"

step "wait for the hub (port.json + /v1/health)"
port="" token=""
for _ in $(seq 1 90); do
  if [ -f "$port_file" ]; then
    port="$(json "$port_file" .port 2>/dev/null || true)"
    token="$(json "$port_file" .token 2>/dev/null || true)"
    if [ -n "$port" ] && curl -fsS -m 2 -H "X-AgentHub-Token: $token" "http://127.0.0.1:$port/v1/health" > /dev/null 2>&1; then
      break
    fi
  fi
  port=""
  sleep 1
done
[ -n "$port" ] || fail "hub did not answer within 90 s"
hub() { curl -fsS -m 5 -H "X-AgentHub-Token: $token" "http://127.0.0.1:$port$1"; }
echo "hub on port $port"
running || fail "the app is not running"

step "hook: SessionStart with an almost empty environment"
printf '{"session_id":"%s","hook_event_name":"SessionStart","cwd":"%s","source":"startup"}' "$session" "$HOME" \
  | env -i HOME="$HOME" PATH=/usr/bin:/bin "$hook" --agent claude-code --event SessionStart \
  || fail "the hook exited with an error"

found=false
for _ in $(seq 1 20); do
  if hub /v1/sessions | grep -q "$session"; then
    found=true
    break
  fi
  sleep 0.5
done
$found || fail "the hub does not list session $session (the hook did not reach the hub)"
echo "session $session reached the hub"

step "quit"
osascript -e "quit app \"$(basename "$app" .app)\"" > /dev/null 2>&1 || true
for _ in $(seq 1 30); do
  running || pgrep -x "$prefix-hub" > /dev/null 2>&1 || break
  sleep 1
done
if running || pgrep -x "$prefix-hub" > /dev/null 2>&1; then
  fail "processes still running 30 s after quit"
fi

printf '\033[32m==> macOS smoke test passed\033[0m\n'
