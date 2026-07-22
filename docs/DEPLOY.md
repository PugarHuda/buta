# Deploying Buta to Coston2

Turnkey once the deployer is funded. The deployer keypair is in
`buta/.env.deployer` (gitignored — the private key never leaves your machine).

## 1. Fund the deployer

The address is printed in `.env.deployer` as `DEPLOYER_ADDRESS`. Send it C2FLR
(and, for real settlement, FXRP + USDT0) from the faucet:

> https://faucet.flare.network/coston2

One faucet claim gives C2FLR + FXRP + USDT0 to the same address.

## 2. Deploy the contract

```bash
cd buta
source .env.deployer
forge script script/Deploy.s.sol \
  --rpc-url "$CHAIN_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast
```

It prints the `ButaInstructionSender` address. Record it in `deployments/` and
in `SUBMISSION.md` (the "Contract addresses" line).

The deploy targets the current FlareTeeManager diamond
`0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`, which plays both the extension
registry and machine registry roles. If Flare cuts a newer diamond, override:

```bash
TEE_MANAGER=0x… forge script script/Deploy.s.sol …
```

> Do **not** point at the old `0x004224fa…` diamond — it predates the
> `ExtensionGovernance` facet and registration reverts with `FunctionNotFound`
> / `only reward offers manager`. This is the single most common failure.

## 3. Register the extension + TEE (for the full on-chain round trip)

The contract deploys and settles standalone, but to run the real (non-simulated)
TEE path you also register the extension and a TEE machine. The scaffold's
`post-build.sh` does this in the correct order after v0.0.22:

```
allow-tee-version  →  set-governance  →  register-tee
```

`set-governance` is the new step; skipping it reverts with
`InvalidGovernanceHash`. Governance env must match on the tools side and inside
the tee-node container:

```
GOVERNANCE_SIGNERS=<DEPLOYER_ADDRESS>
GOVERNANCE_THRESHOLD=1
CHAIN_ID=114
```

Requires tee-node ≥ v0.0.22 and tee-proxy ≥ v0.0.19 (both tagged on GitHub),
and the indexer DB credentials (public, in the hackathon Telegram):

```
username = hackathon_user_57
password = q0El26Hs7Yq8qdN2lBdjGyc7
```

For the hackathon demo you do **not** need this step — Flare accepts the
simulated-TEE path (`BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev`). Registration
gives you a real attested `teeAddress` to pass to `setTeeAddress()`; until then,
`setTeeAddress()` can take the simulated node's address.

## 4. After deploy — flip the landing page

Three spots still say "undeployed"; update them once addresses exist:
- masthead pill (`landing/index.html`)
- the book caption
- the first "Honest scope" item

And fill the `SUBMISSION.md` "Contract addresses" line.
