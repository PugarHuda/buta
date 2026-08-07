# Registering the TEE machine

> **7 August: the extension is 66009 and the contract is
> `0xa03821ADE58EfC07bcB1Eacd4D96ced9C7cDF74D`.** Older numbers below are the
> retired 65642 / `0x3085C895…`; the sequence is unchanged, only the ids are.
> Scripts no longer hardcode either — `scripts/ext-config.mjs` reads
> `config/extension.env`, which is what `pre-build.sh` writes.
>
> **Three things this runbook was missing, all found the hard way on 7 August:**
>
> 1. `docker compose restart extension-tee` keeps the key. `docker compose up -d
>    --force-recreate extension-tee` mints a new one. The rule below is right,
>    but "restart" is the wrong word for which of the two triggers it.
> 2. **Re-registering is not enough — the contract has to be rotated too.**
>    `relayClearing` checks the signature against the address stored by
>    `setTeeAddress`, so a freshly registered machine still cannot settle until
>    `cast send $INSTRUCTION_SENDER "setTeeAddress(address)" <new machine>` runs.
>    Everything else reads healthy in the gap: the machine is PRODUCTION, alone
>    in the active set, and the published URL answers. Only settlement fails,
>    with `BadTeeSignature()`. `npm run verify:submission` now checks this.
> 3. **Retire the old machine before believing any timeout.** Two machines in
>    the active set means `getRandomTeeIds` hands out either, so roughly half the
>    instructions go to an address nobody is listening on and the run dies at "no
>    signed outcome came back" — which reads like a slow network, not a routing
>    error. Three runs were lost to this before `scripts/health.mjs` named it.
>
> ```bash
> node scripts/health.mjs                       # names the stray, if there is one
> node scripts/retire-machine.mjs <old machine>  # pause it
> npm run sync:machine                          # put the live one in the documents
> ```
>
> 4. Recreate BOTH `extension-tee` and `ext-proxy`, not just the enclave. The
>    proxy caches the key it first saw, so recreating the enclave alone leaves
>    `/info` — and therefore health.mjs, and therefore you — reporting a machine
>    that is not the one signing. And give them a minute: the enclave comes up
>    before the proxy is listening and logs `connection refused` posting its
>    first results, which costs the first clearing you ask for.

> **Restarting the container mints a NEW machine.** `tee-node` calls
> `crypto.GenerateKey()` at startup (`internal/node/node.go`) — there is no
> volume, no seed, no env override. `docker compose up -d extension-tee` after a
> code change is enough: the container comes back with a different teeId, the
> registration you did is now for a machine that no longer exists, and the old
> one stays PRODUCTION on-chain forever. `getRandomTeeIds` keeps returning it,
> so `_sendInstruction` routes to an address nobody is listening on.
>
> It is ephemeral **by design** — a TEE identity is supposed to be re-attested,
> not persisted. So the rule is not "avoid restarting", it is: after any restart
> of `extension-tee`, re-register.
>
> ```bash
> EXT_PROXY_HOST_URL=https://<current-tunnel-host> ./scripts/post-build.sh
> node scripts/health.mjs      # must name the machine the proxy is serving
> ```
>
> `post-build.sh` defaults the host to `EXT_PROXY_URL` (localhost), and the
> availability check then 404s because the data providers cannot reach it —
> pass the public host explicitly. `ToProduction` reverting `execution reverted`
> on a second run means it already succeeded; check `onchain-status.mjs` before
> assuming it failed.
>
> **Verified 3 August, machine `0x175fb864555D7a63CE50eCB2997B86677BEaA9A7`:**
> re-registered after a rebuild, PRODUCTION, and a signed `LIST_RFQS` came back
> through the public tunnel with status 1.

> **Done, 31 July.** The machine is PRODUCTION and `getRandomTeeIds(65642, 1)`
> returns `0x473e5B49Aa088Da394c8f873550180047C3377Ee` instead of reverting
> `TooMany()`. `postRfq` now reverts `ERC20: insufficient allowance` — the lot
> token approval, i.e. past `_sendInstruction` and into ordinary business.
>
> It is registered against a **quick tunnel**, which will die. Re-point it with
> `node scripts/update-machine-url.mjs https://<stable-host>` and re-run
> `REGISTER_COMMAND=Rap ./scripts/post-build.sh`.
>
> **31 July, proven end to end.** `postRfq` succeeded on-chain (tx
> `0x6d205171…5369`, rfqCount 0 → 1) and the enclave logged
> `BUTA, POST_RFQ … status 1`. The abi-encoded instruction and the JSON handler
> met for the first time.
>
> Or run `./scripts/tunnel-keeper.sh` and forget about it: it restarts the
> tunnel, notices the hostname moved, republishes it and re-runs the check.
> Measured recovery, unattended: 34 seconds.

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

## Watching it stay up

The keeper republishes the hostname when it moves. Nothing watches the keeper —
and when it dies, nothing moves and nothing complains, so the machine goes
quietly unreachable while the last line anyone saw said "reachable again".

    npm run health          once, exit 0 or 1
    npm run health:watch    every 60s, and it says when the answer CHANGES

Four checks in the order a failure propagates: the proxy is serving, the chain
has a record, the url on-chain actually answers, and the machine is PRODUCTION
with getRandomTeeIds returning it. Each names the component, so the output is
not "something is wrong".

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
- **`config/extension.env`** is written by `pre-build.sh` and committed. Running
  it deploys a new contract and registers a new extension, which for weeks was a
  reason not to — until 7 August, when the pinned-enclave bug made it the only
  way forward. Run it only when the contract itself has to change; everything
  else in this repo reads the ids out of that file, so a redeploy is one command
  followed by `post-build.sh`, `setTeeAddress` and `npm run sync:machine`.
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

What stops the run now is the indexer itself, and it is not a configuration
problem:

```
WARN  Database out of sync. Delayed for 41h57m53s
WARN  Sleeping for 10m0s
DEBUG Checking database for 2/31 time
WARN  Database out of sync. Delayed for 25h8m33s
```

The shared Coston2 indexer is **more than a day behind the chain**. The proxy
will not serve while that is true — it starts, connects, and then sits in a
retry loop, 31 attempts ten minutes apart, so `/info` and `/healthy` stay shut
and `register-tee` has nothing to read.

It is catching up on its own (nearly 17 hours of lag closed between those two
checks), so the loop may well succeed unattended. Leave the stack up and watch:

```bash
docker compose logs -f ext-proxy | grep -E "out of sync|serving"
```

Once it stops saying "out of sync", run `./scripts/post-build.sh`.

Worth telling the group: anyone whose proxy is silently doing nothing right now
is probably sitting in this same loop rather than misconfigured. It also earlier
refused connections outright for a few minutes
(`dial tcp 34.38.42.208:3306: connect: connection refused`) before accepting
them again — a shared instance under load.

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

## Where the run actually got to (29 July)

The indexer caught up on its own, the proxy went healthy, and `post-build.sh`
ran. It got further than anything before it:

```
policy consistency OK: FTDC proxy signing policy 5874 matches on-chain reward epoch 5874
availability check sent, instructionId: ca440c37eef8691ce929b308510ed6679778fcdaf48db07452bd2dd3d927f520
action result status not ok: got: 404 for 0xca440c37…, https://tee-proxy-coston2-1.flare.rocks
```

So: the version is allowed, governance is set, the machine is pre-registered,
the policy pre-flight passes, and the availability check is **on-chain**. What
does not come back is its result — the data providers cannot reach the machine,
because the host URL recorded on-chain is `http://localhost:6674`.

`getRandomTeeIds(65642, 1)` still reverts `TooMany()`: the machine is
INITIALIZED, not PRODUCTION, and only PRODUCTION machines land in
`extensionActiveTeeIds`.

`NORMAL_PROXY_URL` is Flare's own Coston2 FTDC proxy,
`https://tee-proxy-coston2-1.flare.rocks` — that one is the documented endpoint,
unlike the orderbook proxy the frontend used to borrow.

## The availability check needs a public URL

`register-tee` asks the FTDC layer to confirm the machine is reachable at the
host URL recorded on-chain. `localhost` is not reachable from a data provider,
so that step may need a tunnel:

### Two shared defaults to replace before anything is public

The compose file used to default both of these to constants the scaffold
publishes, so every fork that left them alone shared one identity and one key.
Ours went on-chain: the machine's `proxyId` is
`0xF4E021377420Afe90c1A7D2b8968904946633a64`, which is the address of the
scaffold's devnet key. Neither has a default now — compose refuses to start
without them.

```bash
# in .env, which is gitignored
PROXY_PRIVATE_KEY=$(openssl rand -hex 32)
DIRECT_API_KEY=$(openssl rand -hex 24)
```

`DIRECT_API_KEY` is the one that matters once a tunnel exists: `/direct` is how
instructions reach the extension, and a key printed in every fork is not a gate.
Changing `PROXY_PRIVATE_KEY` changes the proxyId, so the machine has to be
registered again — which it does anyway, because the host URL is changing too.

### The tunnel itself

Two scripts, same job — pick by what you have.

**No domain: ngrok.** The free tier includes one static domain that survives
restarts, which is the only property that matters here.



**Domain on Cloudflare:** `cloudflared tunnel login`, then
`./scripts/tunnel-register.sh buta-tee.yourdomain.com`.

Both refuse to publish anything until the proxy answers, wait for the public URL
to actually respond rather than sleeping, and register with the public hostname
as EXT_PROXY_HOST_URL.


**Not a quick tunnel.** `cloudflared tunnel --url …` hands out a hostname that
changes on every restart, and the one the data providers push to is the one
written on-chain. Quantic's pinned message says the machines sitting at
INITIALIZED right now are mostly there for exactly this reason. It needs a
**named** cloudflared tunnel or a reserved ngrok domain, which means logging
into an account.

```bash
cloudflared tunnel login                       # your account
cloudflared tunnel create buta
cloudflared tunnel route dns buta buta-tee.<your-domain>
cloudflared tunnel run --url http://localhost:6674 buta

EXT_PROXY_HOST_URL=https://buta-tee.<your-domain> \
  ./scripts/post-build.sh
```

Then confirm the URL on-chain is the one being served, which is the check the
pinned message recommends before asking anyone for help:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachine(address)((address,address,string))" <teeId>
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" <teeId>     # 1 = INITIALIZED, 2 = PRODUCTION
```

This is B0.3 in `TASKS.md`, and it is now the only thing left.
