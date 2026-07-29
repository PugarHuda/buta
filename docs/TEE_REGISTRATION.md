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
- **`local/tee-proxy` builds** from the tee-proxy repo at v0.0.20. v0.0.19 builds too, but rejects the node with "invalid signature".
- **`config/extension.env`** is written by hand and committed. Do **not** run
  `pre-build.sh`: it deploys a new contract and registers a new extension, and
  we already have both.
- **The registration tooling compiles and is synced to scaffold v0.0.22** —
  `set-governance`, the `bytes32` version, the governance hash on the machine
  data, the domain-separated proxy recovery, the fresh-attestation-on-re-run
  fix and the FTDC policy pre-flight. See `TASKS.md` section 9.

## Where it stands

The hostname arrived — Kristaps posted it in the group on 28 July:

```
INDEXER_DB_HOST=34.38.42.208
```

The `35.241.249.150` in `docs/deployment-steps.md` is dead and VPN-only; he said
he would clean that up. The database is called **`indexer`**, not
`flare_ftso_indexer` — that was a guess and it earned an `Access denied`. Asking
the server settled it in one command:

```bash
docker run --rm mysql:8 mysql -h 34.38.42.208 -u hackathon_user_57 -p'<pw>' \
  -e 'SHOW DATABASES;'
```

With those two the proxy connects, starts, and round-trips `TEE_INFO` with the
node. Three more things had to be fixed to get that far:

- **tee-proxy v0.0.19 rejected the node's response** as "invalid signature".
  v0.0.20 does not. Quantic's pinned message says to run both on develop; this is
  what that means in practice.
- **The node could not sign at all.** Every result came back empty and the proxy
  called it "signature must be 65 bytes, got 0". The node signs over a
  chain-ID-bound payload, and the compose file never passed `CHAIN_ID` — so it
  failed inside `signer.ChainID()` with "could not get chain id", a message that
  never reaches the proxy. The proxy sees only the empty signature and blames
  itself. Fixed in `docker-compose.coston2.yaml`.
- **A cold start deadlocked.** The proxy fetches TEE info at boot and panics
  without it, while the node waited for the proxy to report healthy. It only
  ever appeared to work when a node from an earlier run was still up.
  `depends_on` no longer waits on health.

What stopped the run: the shared indexer began refusing connections
(`dial tcp 34.38.42.208:3306: connect: connection refused`) after having
accepted them minutes before — from the container and from a bare mysql client
alike. It is a shared instance and we had been reconnecting hard while chasing
the errors above. Nothing left to fix on this side; retry when it answers.

Two things from the pinned message that apply when it does:

- **Do not register a quick `trycloudflare` tunnel.** Data providers push to the
  URL stored on-chain and quick-tunnel hostnames change on restart, which is why
  machines are sitting at `INITIALIZED` with dead hostnames. Use a named
  cloudflared tunnel or a reserved ngrok domain.
- **Use `register-tee -command rRap`** — the capital `R` asks for a fresh
  attestation challenge, which is what a re-run needs.

The redeploy did not wipe us: `scripts/onchain-status.mjs` still shows the
diamond recording our contract as the instruction sender for extension 65642, so
there is no need to re-run `pre-build.sh` for a new id.

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
