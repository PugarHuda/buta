# Registering the TEE machine

Buta's contract is live on Coston2 and the extension is registered in the
diamond, but **no TEE machine is registered for extension 65642**. That is the
one thing standing between the desk and the on-chain path:

```
getRandomTeeIds(65642, 1)  ->  reverts TooMany()
```

`MachineManagerFacet.getRandomTeeIds` opens with
`require(_count <= length, TooMany())`, and `length` is
`extensionActiveTeeIds[65642].length()` — zero. `_sendInstruction` calls it on
every `postRfq`, `commitBid` and `requestClearing`, so all three revert before
they reach the diamond. Nothing on-chain can be exercised until a machine is
registered and in production.

## What now works

Everything up to the point below was broken in ways that had nothing to do with
TEE registration, and is fixed:

- **The image builds.** `go.mod` replaced `tee-node` with a checkout in a
  sibling directory, and the Dockerfile copied `tee-node/` and
  `extension-examples/orderbook/` out of the scaffold monorepo — a layout this
  repository does not have, so `docker build` could never work from a clone.
  Both modules are published, so the replaces are gone; the build context is
  this repo. Verified by physically removing the sibling checkouts and building
  both modules from scratch.
- **`local/tee-proxy` builds** from the tee-proxy repo at v0.0.19.
- **`config/extension.env`** is written by hand and committed. Do **not** run
  `pre-build.sh`: it deploys a new contract and registers a new extension, and
  we already have both.
- **The registration tooling compiles and is synced to scaffold v0.0.22** —
  `set-governance`, the `bytes32` version, the governance hash on the machine
  data, the domain-separated proxy recovery, the fresh-attestation-on-re-run
  fix and the FTDC policy pre-flight. See `TASKS.md` section 9.

## What is missing: one hostname

`ext-proxy` panics at startup without the Coston2 c-chain indexer database:

```
PANIC  connecting to database: opening mysql connection to
       ${INDEXER_DB_HOST}:3306/flare_ftso_indexer as hackathon_user_57:
       dial tcp: lookup ${INDEXER_DB_HOST}: no such host
```

It is a hard dependency — the proxy exits rather than degrading — so without it
there is no `/info`, and `register-tee` has nothing to read the machine's
attestation from.

The hackathon credentials are public (`hackathon_user_57` / the password shared
in the Telegram group, already filled into
`config/proxy/extension_proxy.coston2.docker.toml`, which is gitignored). **The
host is not in any repository**; the reference deployment calls it "provided by
the infra team" and leaves `INDEXER_DB_HOST` blank.

So the remaining step is to ask for `INDEXER_DB_HOST` (and confirm the database
name — `flare_ftso_indexer` is the assumption here) in the hackathon group.

## Once the host is known

```bash
# 1. the host, into the gitignored stack env
echo "INDEXER_DB_HOST=<host>" >> .env

# 2. bring the stack up
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d
docker compose logs -f ext-proxy        # must reach "listening", not panic

# 3. register: allow version -> set governance -> register machine -> production
./scripts/post-build.sh
```

`post-build.sh` runs `allow-tee-version`, then **`set-governance`** (added for
v0.0.22 — without it `register-tee` reverts `InvalidGovernanceHash`), then
`register-tee`. `GOVERNANCE_SIGNERS` and `GOVERNANCE_THRESHOLD` must be
identical on both sides; the compose file and the tool default to the same
values, so leaving both unset is the safe choice.

`SIMULATED_TEE=true` is set in `.env`. Flare accept the simulated path for this
program, so the machine does not need Confidential Space hardware.

## Then check it took

```bash
node scripts/onchain-status.mjs
```

and the thing that actually matters:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getRandomTeeIds(uint256,uint256)(address[])" 65642 1 \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

An address instead of a `TooMany()` revert means the blocker is gone, and
`postRfq` can be called on-chain for the first time.

## The availability check may need a public URL

`register-tee` asks the FTDC layer to confirm the machine is reachable at the
host URL recorded on-chain. `localhost` is not reachable from a data provider,
so that step may need a tunnel:

```bash
cloudflared tunnel --url http://localhost:6674
EXT_PROXY_HOST_URL=https://<tunnel-host> ./scripts/post-build.sh
```

This is B0.3 in `TASKS.md`. It is only worth setting up once the proxy starts,
which is why it has not been done yet.
