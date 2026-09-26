#!/usr/bin/env bash
# dev/remote-station-zerotier.sh — run this station with CLAUDE CREW on and reach it from your phone over ZeroTier.
#
# One-time (needs sudo; ZeroTier has no rootless mode):
#   curl -s https://install.zerotier.com | sudo bash
#   sudo zerotier-cli join <your-network-id>          # then authorize this machine at my.zerotier.com
#
# Then:  dev/remote-station-zerotier.sh        -> prints http://<this machine's ZeroTier IP>:8787/
#        dev/remote-station-zerotier.sh stop
#
# The station stays bound to 127.0.0.1; dev/overlay-forward.js listens on the ZeroTier address ONLY and the
# sidecar accepts that address because it is passed as STARNET_REMOTE_HOSTS. Traffic is plain HTTP inside
# ZeroTier's encrypted overlay. Anyone on that ZeroTier network who can reach this address can load the station
# (and the per-launch token in the page) — keep the network private (authorization on, only your devices).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${STARNET_PORT:-8787}"
LOGDIR="${LOGDIR:-$HOME/.local/share/starnet-remote}"
mkdir -p "$LOGDIR"

if [ "${1:-}" = "stop" ]; then
  pkill -f "dev/overlay-forward.js" || true
  pkill -f "node sidecar/index.js" || true
  echo "stopped"; exit 0
fi

# this machine's ZeroTier IPv4 (interfaces are named zt*)
ZT_IP="${ZT_IP:-$(ip -4 -o addr show 2>/dev/null | awk '$2 ~ /^zt/ {split($4,a,"/"); print a[1]; exit}')}"
if [ -z "$ZT_IP" ]; then
  echo "No ZeroTier address found. Install + join first:"
  echo "  curl -s https://install.zerotier.com | sudo bash"
  echo "  sudo zerotier-cli join <network-id>   # then authorize this machine at my.zerotier.com"
  exit 1
fi

# (re)start the station with the ZeroTier IP allowed — a station started without it would refuse the phone
if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  pkill -f "node sidecar/index.js" || true
  for _ in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || break; sleep 0.5; done
fi
STARNET_CLAUDE_CREW=1 STARNET_REMOTE_HOSTS="$ZT_IP" STARNET_PORT="$PORT" \
  nohup node sidecar/index.js >"$LOGDIR/station.log" 2>&1 &
for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done

pkill -f "dev/overlay-forward.js" || true
nohup node dev/overlay-forward.js "$ZT_IP" "$PORT" >"$LOGDIR/forward.log" 2>&1 &
sleep 1
echo "Station: http://$ZT_IP:$PORT/   (open on your phone with ZeroTier on; Chrome menu -> Add to Home screen)"
