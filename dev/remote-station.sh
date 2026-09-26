#!/usr/bin/env bash
# dev/remote-station.sh — run this station with CLAUDE CREW on and reach it from your phone over Tailscale.
#
# No root needed: tailscaled runs in userspace-networking mode under your own user, and `tailscale serve`
# fronts the loopback sidecar with HTTPS at https://<machine>.<tailnet>.ts.net — reachable only by devices
# signed into YOUR tailnet. That name is passed to the sidecar as STARNET_REMOTE_HOSTS, which is the ONLY
# non-loopback Host the API will accept (see sidecar/apiauth.js parseRemoteHosts for the trust note).
#
# First run prints a Tailscale login URL — open it, sign in, then re-run. Your tailnet also needs MagicDNS +
# HTTPS certificates enabled (admin console → DNS) for `tailscale serve` to issue the ts.net cert.
#
#   TS_DIR=~/.local/share/tailscale-user/tailscale_1.102.4_amd64 dev/remote-station.sh
#   dev/remote-station.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."

TS_DIR="${TS_DIR:-$(ls -d "$HOME"/.local/share/tailscale-user/tailscale_*_amd64 2>/dev/null | sort -V | tail -1)}"
STATE="${STATE:-$HOME/.local/share/tailscale-user/state}"
SOCK="$STATE/tailscaled.sock"
PORT="${STARNET_PORT:-8787}"
LOG="${LOG:-$HOME/.local/share/tailscale-user/starnet.log}"
[ -x "$TS_DIR/tailscale" ] || { echo "tailscale binaries not found (set TS_DIR)"; exit 1; }
ts() { "$TS_DIR/tailscale" --socket="$SOCK" "$@"; }
mkdir -p "$STATE"

if [ "${1:-}" = "stop" ]; then
  ts serve --https=443 off 2>/dev/null || true
  pkill -f "node sidecar/index.js" || true
  pkill -f "tailscaled --tun=userspace-networking" || true
  echo "stopped"; exit 0
fi

# 1. userspace tailscaled (idempotent)
if ! ts status >/dev/null 2>&1 && ! pgrep -f "tailscaled --tun=userspace-networking" >/dev/null; then
  nohup "$TS_DIR/tailscaled" --tun=userspace-networking --statedir="$STATE" --socket="$SOCK" \
    >"$STATE/tailscaled.log" 2>&1 &
  sleep 2
fi

# 2. sign in (first run prints a URL and exits non-zero until you approve it)
if ! ts status >/dev/null 2>&1; then
  echo "Sign this machine into Tailscale, then re-run:"
  ts up --hostname="${TS_HOSTNAME:-starnet}" --timeout=15s || true
  exit 1
fi

NAME="$(ts status --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(String(JSON.parse(d).Self.DNSName||"").replace(/\.$/,"")))')"
[ -n "$NAME" ] || { echo "no tailnet DNS name (enable MagicDNS)"; exit 1; }

# 3. the station, loopback-bound, with Claude crew on and the tailnet name allowed
if ! curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  STARNET_CLAUDE_CREW=1 STARNET_REMOTE_HOSTS="$NAME" STARNET_PORT="$PORT" \
    nohup node sidecar/index.js >"$LOG" 2>&1 &
  for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
fi

# 4. HTTPS on the tailnet name -> loopback station
ts serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null
echo "Station: https://$NAME/   (open on your phone; Chrome menu → Add to Home screen for full screen)"
