# Buta — design notes

> Working notes, not the submission doc. `SUBMISSION.md` comes later and must open with the prior-art declaration.

## What this is

A sealed-bid OTC desk on Flare Confidential Compute where **the auctioneer itself cannot see the bids**.

Two rails on one enclave:

| Rail | Trigger | Clearing rule |
|---|---|---|
| `DIRECT_SETTLE` | maker invites one counterparty | taker's offer vs maker's hidden reserve |
| `RFQ_CLEAR` | n sealed bidders, deadline | Vickrey — highest bidder pays second price, floored at reserve |

Both end the same way: enclave computes → signs `TEE_ACTION_RESULT` → contract `ecrecover`s → FXRP settles → lot delivered (optionally redeemed to native XRP on XRPL).

## Why fork `fce-orderbook` and not `fce-extension-scaffold`

The scaffold is Hello World. `fce-orderbook` is a 17.5k-line reference exchange that already ships everything we would otherwise spend two weeks rebuilding:

- vault custody in `InstructionSender.sol` — deposit pulls ERC20 into the contract, `executeWithdrawal(sig)` releases only against a TEE signature, `usedWithdrawalIds` replay guard, write-once `teeAddress`
- the three FCC channels wired end to end: on-chain instruction in, direct action in, signed authorisation out
- balance manager with `Available`/`Held` and `Hold`/`Release`/`Transfer`
- sign-server plumbing and the exact signature preimage
- a React frontend that talks to the proxy, plus a stress harness
- bundled Claude Code skills under `.claude/skills/` (create-extension, test-extension, verify-deploy)

Crucially it is **not** our product: it is a continuous CLOB with price-time priority. Different market microstructure, different problem. A CLOB does not solve block-trade price discovery — that is what the sealed auction is for.

## What we replace

`pkg/orderbook/` (red-black tree + FIFO price levels + `matchBuy`/`matchSell`) comes out. In its place: an auction store keyed by RFQ id holding sealed bid ciphertexts until the deadline, then a single clearing pass.

Keep `pkg/balance/` as is — holds and transfers are identical for an auction.

## What we add that the reference does not have

These four are the actual new work, and each maps to a claim in the submission.

### 1. Bids are ECIES-encrypted; the reference's orders are not

`fce-orderbook` posts direct actions as plaintext JSON: `{sender, pair, side, type, price, quantity}`. Orders are private from *the chain*, but the proxy operator sees them in transit. For a CLOB that is a defensible simplification. For a sealed-bid auction it defeats the entire product.

So bids take the ECIES path from `fce-weather-insurance` instead: fetch `machineData.publicKey` from `GET {EXT_PROXY_URL}/info`, ABI-encode the bid, encrypt under the TEE's secp256k1 key, submit the ciphertext. The extension forwards it to the local tee-node `POST /decrypt`. The private key never leaves the enclave.

### 2. On-chain bid commitments — binding the clearing set

The reference keeps all order state in TEE memory and anchors nothing. Nothing stops a caller from presenting the enclave with a doctored bid set.

This is exactly the attack **Bisik** documented and could not prevent: *"the buyer can suppress the Vickrey uplift — award a subset so the winner clears at its own ask."*

Fix: the contract records a commitment per sealed bid. At clearing the enclave signs over **the commitment set the contract recorded**, not a set the caller handed it. A subset submission fails verification.

One design decision, two problems solved — this is also the persistence answer. The reference loses every resting order on TEE restart (`docs/flows/orders.md`, "Restart and persistence"). For an auction with a deadline that is fatal. On-chain commitments make the bid set replayable.

### 3. Wallet-signature binding on direct actions

`docs/flows/orders.md`, threat model: *"the TEE takes `sender` at face value… a production deployment must bind the request to a wallet signature."* Flare flags the hole themselves.

Buta signs the bid payload with the bidder's wallet and verifies against `req.Sender` inside the handler before any hold. Cheap to do, and it is a concrete improvement on Flare's own reference implementation — worth naming in the submission.

### 4. Cross-chain settlement

The reference is ERC20-only. Buta settles in **FXRP** and delivers the lot, with an optional redeem to native XRP on XRPL.

Coston2 already has the pieces deployed (`config/coston2/deployed-addresses.json`):

```
TeePayments_F_XRP            0xD02384dcbA8bBb42E4E8b417b8542410AE0CF484
TeePaymentsRegistry          0xBEc5C38D5354CEd864b7B736159FaAF722CFAcA7
WalletManagerFacet           0xCf77a93ade70c1D519D19CF9BAd9ec7dfc0765aA
WalletKeyManagerFacet        0xe036B7d737f8ADfAB20D491e676649710EF26806
FlareTeeManager              0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE
Fdc2Verification             0x5dB65be44b4473A06d3D1D70d72D871B09bff965
VrfFacet / VrfVerifier       0xB78215f1587f9F96Ee51532a879246621e55aC35 / 0x3AA6968CBF63A7f3d6A2bD561B8C0F20e76bce9F
```

`TeePayments_F_XRP` and the four Wallet facets are Protocol Managed Wallets, live on Coston2 now. Investigate before building a delivery leg by hand.

The `FlareTeeManager` line above said `0x004224fa…` until 13 August. That is the
retired diamond, and it is the one address here worth being pedantic about:
`docs/DEPLOY.md` calls pointing at it *the single most common failure*, because
it predates the `ExtensionGovernance` facet and registration reverts with
`FunctionNotFound` — a name that tells you nothing about the address being the
cause. Every other address in this block matched `deployed-addresses.json`; only
this one had rotted, in the document a reader consults first.

## Open questions to settle before writing code

1. Does `TeePayments_F_XRP` already give the XRPL delivery leg, or does it only cover fee payment? Read `WalletManagerFacet` + `TeePaymentsRegistry` ABIs off the explorer.
2. `Fdc2Verification` is deployed on Coston2 — is FDC V2 usable for proof-of-funds yet, or still gated?
3. `VrfFacet` — TEE VRF exists. Cheap tie-break for equal top bids; check the interface.
4. Deadline enforcement inside the enclave: `time.Now()` in a TEE is not trustworthy on its own. Prefer anchoring the deadline to a block number the contract stamps on the RFQ.

## Blocker status

`config/proxy/extension_proxy.coston2.toml.example` confirms `ext-proxy` needs indexer DB credentials:

```toml
[db]
host = "<indexer-db-host>"
port = 3306
database = "<indexer-db-name>"
username = "<indexer-db-user>"
password = "<indexer-db-password>"
```

Not published. Request via https://flare.network/resources/technical-support and @FlareDevs. **Kill switch: no credentials by day 5 → drop FCC, move to Bounty 1.**

Development continues meanwhile with `SIMULATED_TEE=true` and `LOCAL_MODE` per `.env.example`.

## Ports

ext-proxy internal 6663→6673, external **6664→6674** (this is the one to tunnel), redis 6379→6382, sign server 7701.
