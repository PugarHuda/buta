#!/usr/bin/env bash
# tunnel-register.sh — publish the extension proxy on a stable hostname and
# register the TEE machine against it.
#
# The availability check fails while the host URL on-chain is localhost: data
# providers push to whatever is written there, and they cannot reach your laptop.
# A quick tunnel does not fix it either — `cloudflared tunnel --url` hands out a
# new hostname every restart, and the one on-chain goes stale. Hence a *named*
# tunnel.
#
# You have to do one thing first, because it opens a browser and picks a domain
# you own:
#
#     cloudflared tunnel login
#
# Then:
#
#     ./scripts/tunnel-register.sh buta-tee.yourdomain.com
#
set -euo pipefail

HOSTNAME_ARG="${1:-}"
TUNNEL_NAME="${TUNNEL_NAME:-buta}"
LOCAL_URL="${LOCAL_URL:-http://localhost:6674}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[tunnel]${NC} $*"; }
step() { echo -e "\n${CYAN}=== $1 ===${NC}"; }
die()  { echo -e "${RED}[tunnel] ERROR:${NC} $*" >&2; exit 1; }

[[ -n "$HOSTNAME_ARG" ]] || die "usage: $0 <hostname>   e.g. buta-tee.yourdomain.com"
command -v cloudflared >/dev/null || die "cloudflared is not installed"

CERT="${HOME}/.cloudflared/cert.pem"
[[ -f "$CERT" ]] || die "no cloudflared credentials at $CERT — run: cloudflared tunnel login"

step "1/5 the proxy has to be serving before anything is published"
curl -fsS -m 10 "${LOCAL_URL}/info" >/dev/null \
  || die "${LOCAL_URL}/info is not answering. Bring the stack up first:
    docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d
  and check the indexer is not lagging:
    docker compose logs ext-proxy | grep 'out of sync'"
log "proxy is answering"

step "2/5 named tunnel"
if cloudflared tunnel list 2>/dev/null | grep -qE "^\S+\s+${TUNNEL_NAME}\s"; then
    log "tunnel '${TUNNEL_NAME}' already exists, reusing it"
else
    cloudflared tunnel create "$TUNNEL_NAME" || die "could not create the tunnel"
fi

step "3/5 dns route"
# Idempotent in practice: routing an already-routed hostname to the same tunnel
# is a no-op, and to a different one is an error worth seeing.
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG" \
  || log "route already present (or refused — check the message above)"

step "4/5 run it"
LOG="$PROJECT_DIR/tunnel.log"
cloudflared tunnel run --url "$LOCAL_URL" "$TUNNEL_NAME" >"$LOG" 2>&1 &
TUNNEL_PID=$!
log "cloudflared pid $TUNNEL_PID, logging to $LOG"

# Wait for the hostname to actually answer, rather than sleeping and hoping.
log "waiting for https://${HOSTNAME_ARG}/info ..."
for i in $(seq 1 60); do
    if curl -fsS -m 8 "https://${HOSTNAME_ARG}/info" >/dev/null 2>&1; then
        log "public URL is live"
        break
    fi
    [[ $i -eq 60 ]] && die "https://${HOSTNAME_ARG}/info never answered. Tunnel log:
$(tail -20 "$LOG")"
    sleep 3
done

step "5/5 register the machine against the public URL"
# EXT_PROXY_URL stays local — that is how the tools talk to the proxy.
# EXT_PROXY_HOST_URL is what gets written on-chain, and it is the whole point.
#
# -command rRap: capital R asks for a FRESH attestation challenge. The challenge
# is one-shot, so a re-run that reuses the old one dies with ChallengeExpired.
EXT_PROXY_URL="$LOCAL_URL" \
EXT_PROXY_HOST_URL="https://${HOSTNAME_ARG}" \
NORMAL_PROXY_URL="${NORMAL_PROXY_URL:-https://tee-proxy-coston2-1.flare.rocks}" \
CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}" \
ADDRESSES_FILE="${ADDRESSES_FILE:-config/coston2/deployed-addresses.json}" \
REGISTER_COMMAND="rRap" \
    bash "$SCRIPT_DIR/post-build.sh" || {
        echo
        echo "Registration failed. The tunnel is still running (pid $TUNNEL_PID)."
        echo "The state file lets you resume: config/register-tee.state"
        exit 1
    }

echo
log "done. Check the two things that decide whether it took:"
cat <<EOF

  # is the URL on-chain the one you are serving?
  cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \\
    "getTeeMachine(address)((address,address,string))" <teeId>

  # 1 = INITIALIZED, 2 = PRODUCTION
  cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \\
    "getTeeMachineStatus(address)(uint8)" <teeId>

  # and the one that matters — an address instead of TooMany()
  cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \\
    "getRandomTeeIds(uint256,uint256)(address[])" 65642 1

Leave the tunnel running. If it stops, the hostname on-chain goes dead and the
machine drops back to unreachable — that is why this is a named tunnel and not a
quick one.
EOF
