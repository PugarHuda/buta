#!/usr/bin/env bash
# tunnel-keeper.sh — keep the TEE machine reachable without owning a domain.
#
#   ./scripts/tunnel-keeper.sh
#
# Data providers push the availability check to the URL written on-chain. A quick
# tunnel hands out a new hostname every time it starts, so the moment cloudflared
# restarts the machine points at a dead address and drops out of PRODUCTION. That
# is why the advice is to use a named tunnel — and a named tunnel needs an
# account and a domain.
#
# Rather than require the hostname to be stable, this makes the on-chain record
# follow it: run cloudflared, and whenever the chain disagrees with what we are
# serving, update the machine and re-run the availability check.
#
# Not better than a static domain. Each rotation costs gas and leaves a minute or
# two unreachable. But it needs nothing except this machine, and it survives
# restarts unattended. Switch to tunnel-register-ngrok.sh once a static domain
# exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_PORT="${LOCAL_PORT:-6674}"
CHECK_EVERY="${CHECK_EVERY:-60}"
TUNNEL_LOG="${TUNNEL_LOG:-$PROJECT_DIR/tunnel.log}"

# The updater needs viem, which lives in the sibling TypeScript repo.
UPDATER_DIR="${UPDATER_DIR:-$PROJECT_DIR/../undelayed}"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
log() { echo -e "${GREEN}[keeper $(date +%H:%M:%S)]${NC} $*"; }
die() { echo -e "${RED}[keeper] ERROR:${NC} $*" >&2; exit 1; }

command -v cloudflared >/dev/null || die "cloudflared is not installed"
[[ -d "$UPDATER_DIR/node_modules/viem" ]] \
  || die "viem not found in $UPDATER_DIR — npm install there, or set UPDATER_DIR"

start_tunnel() {
    log "starting a quick tunnel"
    cloudflared tunnel --url "http://localhost:${LOCAL_PORT}" --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    for _ in $(seq 1 40); do
        HOST=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" | head -1 || true)
        if [[ -n "$HOST" ]]; then
            log "tunnel is $HOST (pid $TUNNEL_PID)"
            return 0
        fi
        kill -0 "$TUNNEL_PID" 2>/dev/null || die "cloudflared exited: $(tail -5 "$TUNNEL_LOG")"
        sleep 2
    done
    die "cloudflared never printed a hostname: $(tail -10 "$TUNNEL_LOG")"
}

# The updater is idempotent and prints UNCHANGED or CHANGED, so it doubles as the
# comparison: there is nothing to re-run when the chain already agrees.
republish() {
    local out
    if ! out=$(cd "$UPDATER_DIR" && node "$SCRIPT_DIR/update-machine-url.mjs" "$HOST" 2>&1); then
        log "update failed, retrying next cycle"
        return 1
    fi
    if grep -q UNCHANGED <<<"$out"; then
        return 0
    fi
    log "on-chain url is now $HOST — re-running the availability check"

    EXT_PROXY_URL="http://localhost:${LOCAL_PORT}" \
    EXT_PROXY_HOST_URL="$HOST" \
    NORMAL_PROXY_URL="${NORMAL_PROXY_URL:-https://tee-proxy-coston2-1.flare.rocks}" \
    CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}" \
    ADDRESSES_FILE="${ADDRESSES_FILE:-config/coston2/deployed-addresses.json}" \
    REGISTER_COMMAND="Rap" \
        bash "$SCRIPT_DIR/post-build.sh" >/dev/null 2>&1 \
        || { log "availability check failed, retrying next cycle"; return 1; }

    log "machine is reachable again"
}

cleanup() { [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true; }
trap cleanup EXIT

start_tunnel
republish || true

while true; do
    sleep "$CHECK_EVERY"
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
        log "cloudflared died — restarting"
        start_tunnel
    fi
    republish || true
done
