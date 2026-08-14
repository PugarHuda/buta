#!/usr/bin/env bash
# tunnel-register-ngrok.sh - publish the extension proxy on a static ngrok
# domain and register the TEE machine against it.
#
# Same job as tunnel-register.sh, for people without a domain on Cloudflare.
# Every ngrok account gets ONE free reserved domain (a .ngrok-free.dev name) that
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

Get one free at https://dashboard.ngrok.com/domains - a random URL will not do,
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

step "1b/5 nothing else may be publishing a hostname"
# tunnel-keeper.sh republishes a cloudflare quick-tunnel URL whenever the chain
# disagrees with what it is serving - every 60 seconds, forever. Left running,
# it would overwrite the static domain minutes after this script wrote it, and
# the only symptom would be the machine going unreachable again later, for no
# visible reason. Stop it first; that is the whole point of moving off it.
if pgrep -f "tunnel-keeper.sh" >/dev/null 2>&1; then
    die "scripts/tunnel-keeper.sh is still running. It republishes a quick-tunnel
  hostname on a timer and would overwrite ${DOMAIN} within a minute. Stop it:
    pkill -f tunnel-keeper.sh
  and stop the cloudflared it started:
    pkill -f cloudflared"
fi
log "no keeper running"

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

step "4b/5 publish the hostname on-chain BEFORE asking anyone to check it"
# post-build.sh does not update the URL of a machine that is already registered
# - it re-attests the one already on record. So on a machine that exists, the
# availability check below gets pushed to whatever hostname was published last,
# which after a switch is a tunnel that no longer exists. The symptom is a 404
# on the action result and a registration that "failed" while everything local
# is perfectly healthy. Publishing first costs one transaction and removes the
# whole failure mode.
node "$SCRIPT_DIR/update-machine-url.mjs" "https://${DOMAIN}" \n  || die "could not publish the hostname on-chain - nothing below would reach this machine"

step "5/5 register the machine against the public URL"
# EXT_PROXY_URL stays local - that is how the tools reach the proxy.
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

echo
log "registered. Checking it took:"

# This used to print three cast commands against a hardcoded teeId, which was
# wrong the moment the container restarted - tee-node mints a new key at every
# start, so the id in a script is an id for a machine that may not exist. Run
# the check instead of printing it, and let it derive the id from the key the
# proxy is actually serving.
node "$SCRIPT_DIR/health.mjs" || {
    echo
    echo "Registration went through but the machine is not healthy - read the lines above."
    exit 1
}

cat <<'EOF'

Leave ngrok running. If it stops, the hostname on-chain stops answering and the
machine goes unreachable again - which is why this is a static domain and not a
random one.
EOF
