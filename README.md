# Buta

**A sealed-bid OTC desk on Flare Confidential Compute where the auctioneer itself cannot read the bids.**

Bids are ECIES-encrypted to an attested enclave; the enclave clears them at the
Vickrey second price and forgets them; the winner and clearing price are public,
but every losing amount — and the winner's own bid — stays sealed forever. A
bidder can still prove their exact bid to a chosen auditor without it becoming
public.

Built for **Flare Summer Signal 2026**, Bounty 2 (Confidential Compute).

- **Live:** https://buta-desk.vercel.app — the landing page, and the desk itself at [/dashboard](https://buta-desk.vercel.app/dashboard)
- **Contract (Coston2, verified):** [`0x20d9CcAA7140bf38AD91D2F102bA996417798e8f`](https://coston2-explorer.flare.network/address/0x20d9CcAA7140bf38AD91D2F102bA996417798e8f) — registered in the FCC diamond as extension `65642`. Verify with `node scripts/onchain-status.mjs`.
- **Full write-up:** [`SUBMISSION.md`](SUBMISSION.md) · **Demo script:** [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md) · **Deploy:** [`docs/DEPLOY.md`](docs/DEPLOY.md)

---

## Why an enclave, and not just a smart contract?

A Vickrey (second-price) auction **cannot be run honestly on a transparent
chain.** To compute the second price you must know every bid; to know every bid
on-chain is to publish it; to publish it is to destroy the sealed auction.

Every on-chain "dark" venue leaves one reader standing — whatever clears the
auction can read every bid, and can lie about it. Zero-knowledge doesn't remove
that reader (the prover holds the openings); threshold decryption doesn't
(whoever satisfies the policy reads them); a private ledger doesn't (the buyer
sees all quotes); homomorphic evaluation is too expensive to rank N bids for one
trade. **An attested enclave is the first mechanism that both computes the
clearing correctly and holds the bids where no interested party can read them.**

## The security chain (each link has a test that tries to break it)

```
bid ECIES-encrypted to the enclave      → operator sees only ciphertext
opening reproduces its commitment       → keccak(amount‖nonce‖addr), or it bounces
bid bound to a wallet signature         → ecrecover == bidder, or it bounces
opening set matches what chain recorded → a trimmed set is refused
enclave signs a digest of that set      → keccak over the sorted commitments
contract verifies the TEE signature     → domain-separated ecrecover + replay guard
contract rejects a mismatched digest    → "award a subset" reverts on-chain
```

The last link is the point: the contract records the commitment set **before
anyone knows what is in it**, and refuses any clearing whose digest doesn't match
— so the auctioneer cannot quietly drop a bid to move the price. It stops being
a policy promise and becomes a transaction that reverts.

## Run it

Simulated-TEE path (accepted by Flare for the hackathon):

```bash
# 1. the extension + a dev facade (real extension code, simplified transport)
BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev

# 2. seed a book that looks alive, then start the desk
cd frontend
node scripts/seed.mjs
npm run dev            # desk on http://localhost:5173
```

Post a block, seal a bid (real wallet signature + ECIES), clear at the second
price, and disclose your bid to an auditor from the Portfolio tab.

## Tests

```bash
go test ./pkg/auction/... ./internal/extension/...   # clearing + handlers, no-leak assertions
forge test                                            # 15 tests — relayClearing, trimmed-set, replay, reclaim
```

## Layout

```
pkg/auction/            Vickrey clearing engine (enclave-only); losing amounts never returned
internal/extension/     RFQ store + handlers: POST_RFQ / COMMIT_BID / CLEAR_AUCTION / disclosure
  decrypt.go            ECIES decryptor interface — tee-node /decrypt in prod, local key in dev
contracts/              ButaInstructionSender.sol — commitment set, set-digest binding, TEE-sig verify
script/Deploy.s.sol     one-command Coston2 deploy
cmd/dev/                one-process dev facade (extension + the two proxy routes the desk uses)
frontend/               the desk — post / seal / clear / disclose, Swiss-industrial print
frontend/landing/       the landing page, served at / (the desk is at /dashboard)
```

## Prior work — declared

We built this same sealed-bid thesis five times before, on five other chains
(iExec, Stellar, Sui, Zama, Canton). Each left the same open problem: *the
settler still sees the bids.* Buta is the build where an attested enclave finally
removes that reader. See [`SUBMISSION.md`](SUBMISSION.md) for the full separation
of what carried over vs what is new for Flare.

## Scope

Not audited. Not for real assets. The clearing price is public by design
(Vickrey pays the second price). Hiding the openings even from the enclave would
need MPC — honest future work. The contract is deployed, verified, and
registered in the FCC diamond (extension 65642); the product runs on the
simulated-TEE path Flare accepts. Registering a real attested TEE machine
(Level 2) is the next step (`docs/DEPLOY.md`).

## License

Apache-2.0. Forks `flare-foundation/fce-orderbook` for the TEE signing path and
extension plumbing; the sealed-bid mechanism, commitment binding, and desk are
new. The fork's order book and deposit/withdraw vault have been deleted — this
contract settles directly, so neither could ever be reached.
