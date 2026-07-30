#!/usr/bin/env bash
# tunnel-register-ngrok.sh — publish the extension proxy on a static ngrok
# domain and register the TEE machine against it.
#
# Same job as tunnel-register.sh, for people without a domain on Cloudflare.
# ngrok's free tier includes ONE static domain (something.ngrok-free.app) that
# survives restarts, which is the property that matters: data providers push to
# the URL written on-chain, so a hostname that changes leaves the machine
# unreachable and stuck at INITIALIZED.
#
# Do NOT use a random ngrok URL for this. It works for five minutes and then the
# registration is dead.
#
# Two things to do once, on ngrok.com:
#   1. copy your authtoken   -> ngrok config add-authtoken <token>
#   2. claim the free static domain on the Domains page
#
# Then:
#   ./scripts/tunnel-register-ngrok.sh your-name.ngrok-free.app
#
set -euo pipefail

DOMAIN="${1:-}"
LOCAL_PORT="${LOCAL_PORT:-6674}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[tunnel]${NC} $*"; }
step() { echo -e "\n${CYAN}=== $1 ===${NC}"; }
die()  { echo -e "${RED}[tunnel] ERROR:${NC} $*" >&2; exit 1; }

[[ -n "$DOMAIN" ]] || die "usage: $0 <static-domain>   e.g. buta-tee.ngrok-free.app

Get one free at https://dashboard.ngrok.com/domains — a random URL will not do,
because the hostname goes on-chain and has to still be yours tomorrow."

# winget installs it outside PATH for this shell, so look there too.
NGROK="${NGROK:-$(command -v ngrok || true)}"
if [[ -z "$NGROK" ]]; then
    CANDIDATE="$HOME/AppData/Local/Microsoft/WinGet/Packages/Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe/ngrok.exe"
    [[ -x "$CANDIDATE" ]] && NGROK="$CANDIDATE"
fi
[[ -n "$NGROK" ]] || die "ngrok not found. winget install Ngrok.Ngrok"

step "1/5 authtoken"
"$NGROK" config check >/dev/null 2>&1 \
  || die "ngrok has no authtoken yet. Get it from
    https://dashboard.ngrok.com/get-started/your-authtoken
  then:
    '$NGROK' config add-authtoken <token>"
log "authtoken present"

step "2/5 the proxy has to be serving before anything is published"
curl -fsS -m 10 "http://localhost:${LOCAL_PORT}/info" >/dev/null \
  || die "http://localhost:${LOCAL_PORT}/info is not answering. Bring the stack up:
    docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d
  and check the indexer is not lagging:
    docker compose logs ext-proxy | grep 'out of sync'"
log "proxy is answering"

step "3/5 open the tunnel on ${DOMAIN}"
LOG="$PROJECT_DIR/tunnel.log"
# ngrok 3.3 uses --domain; newer builds accept --url as well.
"$NGROK" http "--domain=${DOMAIN}" "$LOCAL_PORT" --log=stdout >"$LOG" 2>&1 &
NGROK_PID=$!
log "ngrok pid $NGROK_PID, logging to $LOG"
trap 'echo; echo "[tunnel] ngrok is still running as pid '"$NGROK_PID"'"' EXIT

step "4/5 wait for the public URL to answer"
for i in $(seq 1 40); do
    if curl -fsS -m 8 "https://${DOMAIN}/info" >/dev/null 2>&1; then
        log "https://${DOMAIN}/info is live"
        break
    fi
    if ! kill -0 "$NGROK_PID" 2>/dev/null; then
        die "ngrok exited. Log:
$(tail -20 "$LOG")"
    fi
    [[ $i -eq 40 ]] && die "https://${DOMAIN}/info never answered. Log:
$(tail -20 "$LOG")"
    sleep 3
done

step "5/5 register the machine against the public URL"
# EXT_PROXY_URL stays local — that is how the tools reach the proxy.
# EXT_PROXY_HOST_URL is what gets written on-chain, and it is the whole point.
# rRap: the capital R asks for a FRESH attestation challenge, because the
# previous one is single-use and a re-run with the old one dies ChallengeExpired.
EXT_PROXY_URL="http://localhost:${LOCAL_PORT}" \
EXT_PROXY_HOST_URL="https://${DOMAIN}" \
NORMAL_PROXY_URL="${NORMAL_PROXY_URL:-https://tee-proxy-coston2-1.flare.rocks}" \
CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}" \
ADDRESSES_FILE="${ADDRESSES_FILE:-config/coston2/deployed-addresses.json}" \
REGISTER_COMMAND="${REGISTER_COMMAND:-rRap}" \
    bash "$SCRIPT_DIR/post-build.sh" || {
        echo
        echo "Registration failed, and the tunnel is still up (pid $NGROK_PID)."
        echo "Progress is in config/register-tee.state, so a re-run resumes."
        exit 1
    }

TEE_ID="0x473e5B49Aa088Da394c8f873550180047C3377Ee"
DIAMOND="0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE"
RPC="https://coston2-api.flare.network/ext/C/rpc"

echo
log "registered. The three reads that say whether it took:"
cat <<EOF

  # is the URL on-chain the one you are actually serving?
  cast call ${DIAMOND} \\
    "getTeeMachine(address)((address,address,string))" ${TEE_ID} --rpc-url ${RPC}

  # 1 = INITIALIZED, 2 = PRODUCTION
  cast call ${DIAMOND} \\
    "getTeeMachineStatus(address)(uint8)" ${TEE_ID} --rpc-url ${RPC}

  # the one that matters — an address instead of a TooMany() revert
  cast call ${DIAMOND} \\
    "getRandomTeeIds(uint256,uint256)(address[])" 65642 1 --rpc-url ${RPC}

Leave ngrok running. If it stops, the hostname on-chain stops answering and the
machine goes unreachable again — which is why this is a static domain and not a
random one.
EOF
