# Buta — Flare Summer Signal submission

**Bounty:** Confidential Compute Apps (Bounty 2)
**One line:** A sealed-bid OTC desk on Flare Confidential Compute where the auctioneer itself cannot read the bids.

---

## Prior work — declared up front

This is not our first sealed-bid desk. We have built this same market mechanism — sealed bids, Vickrey clearing, selective disclosure — five times before, on five chains, each time fighting that chain's transparency with different privacy machinery: **Diam** (Arbitrum, iExec Nox TEE), **Segel** (Stellar, Groth16 ZK), **Sealed Pair** (Sui, Walrus + Seal), **Samar** (Ethereum, Zama fhEVM), and **Bisik** (Canton, ledger-native privacy). Every one shipped, and every one had to write the same confession into its README: *the settler still sees the bids.* Two of them said so in as many words — Bisik: *"only the buyer sees all the sealed quotes… forcing the true second price needs a trusted auctioneer or MPC; that is future work."* Segel: *"a sealed auction's settler necessarily sees the bid openings… hiding them from the auctioneer too needs MPC."*

**Buta is the build where that confession finally goes away.** Nothing was ported wholesale. What carried over is architecture and hard-won market design (Vickrey clearing, the commitment scheme, the disclosure flow, the QA discipline). What is **new for Flare**, and impossible on the five earlier stacks, is the thing that removes the reader: an **attested enclave that is not a party to the trade**, plus **on-chain commitments that make the bid set un-trimmable**. Everything in "What was newly built" below was written during this program against Flare's FCC.

---

## The problem, stated as a problem (not a tech demo)

Desks that move size do not trade on public order books, because the moment a large block's bids are visible the market front-runs them. So price discovery for size happens in chat rooms and over the phone — opaque, un-auditable, and dependent on trusting a desk operator with the spread. On-chain "dark" venues promise to fix this, but every one of them leaves **one reader standing**: whatever computes the clearing can also read every bid, and can lie about it — drop the inconvenient ones, clear at a worse price, leak a number to a friend.

Buta is a sealed-bid desk where **no one runs the auction**. Bids are encrypted to an attested enclave; the enclave clears them and forgets them; the losing amounts are never revealed to anyone — not the chain, not the operator, not the desk. It is exactly the problem confidential compute is for.

**Who this is for:** OTC desks, treasuries, and market makers clearing block trades in FXRP and other Flare assets — anyone for whom leaking order size before settlement is unacceptable.

---

## The four questions the bounty asks

### 1. What runs privately inside the TEE?
The **clearing engine** (`pkg/auction`). It receives the decrypted bid openings, ranks them, computes the Vickrey second price floored at the maker's hidden reserve, and produces a signed outcome. The bid amounts exist in the clear **only inside the enclave process** and are never written to a response, a log, or the chain. The maker's reserve is decrypted there too and never leaves.

### 2. What is verified or consumed on-chain?
`ButaInstructionSender.sol` does three things the enclave cannot:
- **Records the commitment set.** Every sealed bid appends a 32-byte commitment on-chain *before anyone knows what is in it*. This is the load-bearing idea.
- **Verifies the enclave's signature** over the clearing result, using EIP-191 `ecrecover` against a domain-separated payload (`keccak256(abi.encode("TEE_ACTION_RESULT", chainid, resultHash))`) with replay protection.
- **Rejects any clearing whose `setDigest` does not equal the digest of the commitments the contract recorded.** This is what turns "the auctioneer could award a subset to suppress the Vickrey uplift" from a policy promise into a transaction that reverts.

### 3. What trust assumptions remain?
- **The attestation.** You trust that the enclave runs the registered code hash — that is the FCC security model, and it is what lets us say the operator cannot substitute a version that leaks. You do not trust *us*; you check the hash.
- **The settler sees the openings.** An auctioneer, by definition, sees the bids it clears — that is normal. What Buta guarantees is that this settler is a *neutral attested enclave*, not a party to the trade, and that it cannot be fed a doctored bid set. Hiding the openings even from the enclave would need MPC; that is genuine future work, and we say so.
- **Digest binding.** The set digest is keccak256 over the sorted commitment set, byte-identical on the Go and Solidity sides (both pin the same test vector). Collision resistance rests on keccak.

### 4. Why does this need confidential compute, and not an ordinary smart contract?
Because a **Vickrey (second-price) auction cannot be run honestly on a transparent chain.** To compute the second price you must know every bid; to know every bid on-chain is to publish it; to publish it is to destroy the sealed auction. Zero-knowledge doesn't remove the reader (the prover holds the openings), threshold decryption doesn't (whoever satisfies the policy reads them), a private ledger doesn't (the buyer sees all quotes), and homomorphic evaluation is too expensive to rank N bids for a single trade. An attested enclave is the first mechanism that both computes the clearing correctly *and* holds the bids where no interested party can read them. Remove the enclave and the product cannot exist.

---

## What was newly built during the program

Everything here was written against Flare FCC during Summer Signal, forking Flare's own `fce-orderbook` reference for the TEE signing path and the extension plumbing, then going past it.

The fork also arrived with a central-limit order book and a deposit/withdraw vault. Both are **deleted**, not disabled: `ButaInstructionSender` settles the lot and the payment itself and has no deposit or withdraw function, so those handlers could never be reached. Custody you cannot enter reads like a feature when it is dead code. That removal is 11,000 lines — the repo is now only the sealed-bid desk.

| Area | New work | Where |
|---|---|---|
| Clearing engine | Vickrey second-price clearing; losing amounts never returned; deterministic tie-break so two enclaves agree | `pkg/auction` |
| Commitment binding | `keccak256(amount‖nonce‖addr)`, recomputed at ingest and at clear — a commitment that means something | `pkg/auction`, `internal/extension/rfq.go` |
| Un-trimmable set | On-chain commitment set + `setDigest` check; keccak over the sorted set, Go/Solidity byte-parity | `ButaInstructionSender.sol` |
| ECIES-sealed bids | Opening encrypted to the enclave key from `GET /info`; operator sees only ciphertext | `internal/extension/decrypt.go`, `frontend/src/lib/buta.ts` |
| Wallet-bound bids | `personal_sign` over `keccak("BUTA_BID"‖rfqId‖commitment)`, recovered in the enclave — closes the sender-at-face-value hole the reference orderbook documents in its own threat model | `internal/extension/rfq.go` |
| Selective disclosure | Prove your exact bid to an auditor without it going public; sharpest for the winner | `frontend/src/pages/Folio.tsx` |
| Two-sided settlement | DvP: winner pays the second price, receives the lot; `reclaimLot` refunds an unsold auction | `ButaInstructionSender.sol` |
| The desk | Post / seal / clear / disclose UI, Swiss-industrial print language | `frontend/` |

**Improved on Flare's reference specifically:** bids arrive as ciphertext (the reference posts plaintext JSON the proxy can read); requests are bound to a wallet signature (the reference "takes `sender` at face value" and says a production build must fix this); the bid set is anchored on-chain (the reference keeps everything in enclave memory and loses it on restart).

---

## What is deployed / how far we got

- **Coston2** — `ButaInstructionSender` is deployed, **source-verified on the explorer**, and **registered in the live FCC diamond** as extension **65642** (`setExtensionId` + `setTeeAddress` done on-chain). Run `node scripts/onchain-status.mjs` to confirm every line from public reads. **The full on-chain path is live.** `postRfq` executed on Coston2 (tx `0x6d205171d791b72546e589bc9622ec1d3f3720a3b9e799e0833b355085409369`, rfqCount 0 → 1), the instruction was delivered to the enclave, and the enclave processed it: `routing action with OPType, OPCommand: BUTA, POST_RFQ` → `status 1`, empty log. A **TEE machine is registered and in PRODUCTION** for extension 65642: `getRandomTeeIds(65642, 1)` returns `0x175fb864…A9A7` instead of reverting `TooMany()`, so `_sendInstruction` resolves and `postRfq` reaches the diamond — it now fails on the lot-token allowance, which is ordinary business rather than a wall. The full product flow (post → seal ECIES bids → Vickrey clear → settle → disclose) also runs end to end on the simulated-TEE path Flare accepts.
- **Verified live, not just unit-tested:** `/info` → `ecies-geth` encrypt → 348-byte ciphertext → enclave decrypts, recovers the wallet signature, records the bid; clearing returns the winner and second price with **no hidden number anywhere in the outcome**; an unsigned or lying bid bounces with a named error.
- **Tests:** Go `pkg/auction` + `internal/extension` (full sealed lifecycle, forged sender, replayed signature, lying opening, no-leak assertion); 15 Foundry tests on the contract (the security-critical `relayClearing`, the trimmed-set rejection, signature and replay checks, `reclaimLot`).
- **Landing page:** https://buta-desk.vercel.app
- **Contract (Coston2, verified):** `0x20d9CcAA7140bf38AD91D2F102bA996417798e8f` — [explorer](https://coston2-explorer.flare.network/address/0x20d9CcAA7140bf38AD91D2F102bA996417798e8f) · FCC extension id **65642**

> Honest scope, on the record: the clearing price is public by design (Vickrey pays the second price, so that number is on-chain — what stays sealed is which bid produced it and every amount that lost). FCC itself is pre-production and being reworked on Coston2. Our machine is registered and PRODUCTION, but it is published through a rotating quick tunnel rather than a domain we own, so `scripts/tunnel-keeper.sh` republishes the hostname on-chain whenever it moves — measured recovery 34 seconds. A static domain would be better and needs nothing but an account.

---

## Proven on Coston2, not described

Every row is checkable without asking us. `node scripts/onchain-status.mjs` reads
the first four from public state and needs no key.

| Step | Evidence |
|---|---|
| Contract deployed and source-verified | `ButaInstructionSender` at [`0x20d9CcAA7140bf38AD91D2F102bA996417798e8f`](https://coston2-explorer.flare.network/address/0x20d9CcAA7140bf38AD91D2F102bA996417798e8f) |
| Registered in the live FCC diamond | extension **65642** — the diamond returns our contract for `getTeeExtensionInstructionsSender(65642)` |
| TEE address bound on-chain | `setExtensionId()` + `setTeeAddress()`, both done; `teeAddressSet` reads true |
| **TEE machine in PRODUCTION** | `0x175fb864555D7a63CE50eCB2997B86677BEaA9A7`, `getTeeMachineStatus` = 2. `getRandomTeeIds(65642, 1)` returns it instead of reverting `TooMany()`. The first machine, `0x473e5B49…77Ee`, is PAUSED — a restarted container mints a new key, and leaving the old one active means half the instructions route to nobody (`scripts/retire-machine.mjs`) |
| **`postRfq` executed on-chain** | tx [`0x6d205171d791b72546e589bc9622ec1d3f3720a3b9e799e0833b355085409369`](https://coston2-explorer.flare.network/tx/0x6d205171d791b72546e589bc9622ec1d3f3720a3b9e799e0833b355085409369), `rfqCount` 0 → 1 |
| **The enclave received and processed it** | `routing action with OPType, OPCommand: BUTA, POST_RFQ` → `result of action 0x085ff708… obtained, status 1`, empty log |
| Machine host published and re-published | `updateTeeMachineSettings` tx `0xb1b4c08cedeab3d70f4a730ea306ef43114e637a71f84de4d329ff6910988693` |
| Settlement against real FXRP | `FORK=1 forge test --match-path test/ButaSettleFork.t.sol` — the clearing moves genuine FTestXRP (`0x0b6A3645…73dc7`) on a Coston2 fork, balances taken from a real holder rather than dealt |

The two bold rows are the ones that took the longest and matter most. Until 31
July the contract and the enclave had never spoken: the contract encoded ABI, the
handler parsed JSON, and nothing converted between them — invisible, because no
machine was registered to deliver an instruction and prove it.

## Roadmap / next steps

1. **A stable hostname and hardware attestation.** The machine is registered and PRODUCTION today on the simulated path Flare accepts; what is left is a static domain instead of a rotating tunnel, and swapping the simulated decryptor for the tee-node `/decrypt` path already wired behind the `Decryptor` interface.
2. **Settle in real FXRP** (`0x0b6A3645…` on Coston2) and add the **XRPL delivery leg** via Protocol Managed Wallets, so the winner can take the lot as native XRP.
3. **Proof-of-funds via FDC** to replace full escrow — a bidder proves they hold the funds without locking them.
4. **MPC clearing** as the honest long-term answer to "the settler sees the openings."

---

## Repository

- Code: https://github.com/PugarHuda/buta *(see the repo for build/run: `BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev`, then `npm run dev` in `frontend/`)*
- Not audited. Not for real assets. Built for Flare Summer Signal, 2026.
