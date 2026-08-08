# DoraHacks submission form — ready to paste

Fill the Summer Signal form with these. Order follows the "Submission
Requirements" list on the hackathon page. Full detail lives in `SUBMISSION.md`;
this is the trimmed, field-by-field version.

---

**Project name**
Buta

**Selected bounty**
Bounty 2 — Confidential Compute Apps

**Short product description**
Buta is a sealed-bid OTC desk on Flare Confidential Compute where the auctioneer
itself cannot read the bids. Desks moving size post a block; takers submit bids
that are ECIES-encrypted to an attested enclave; the enclave clears them at the
Vickrey second price and forgets them. The winner and clearing price are public;
every losing amount, the winner's own bid, and the maker's reserve stay sealed
forever. A bidder can still prove their exact bid to a chosen auditor without it
becoming public.

**Target user**
OTC desks, treasuries, and market makers clearing block trades in FXRP and other
Flare assets — anyone for whom leaking order size before settlement is
unacceptable.

**Demo link / video / working app**
- Live: https://buta-desk.vercel.app — landing at /, working desk at /dashboard
- Demo video: _[paste your recorded link — script in DEMO_SCRIPT.md]_
- Run locally: `BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev` then `npm run dev`
  in `frontend/`. A TEE machine is registered and PRODUCTION for extension 66009, so instructions reach the diamond; the enclave itself runs the simulated-TEE path Flare accepts for this hackathon.

**GitHub / technical materials**
https://github.com/PugarHuda/buta

**How the project uses Flare**
Flare Confidential Compute (FCC) is load-bearing, not namechecked. The clearing
runs inside a TEE (the `pkg/auction` engine); bids are ECIES-encrypted to the
enclave's key from `GET /info`; the on-chain `ButaInstructionSender` records the
commitment set, verifies the enclave's signature over the result with a
domain-separated `ecrecover`, and refuses any clearing whose set-digest doesn't
match the commitments it recorded — so the auctioneer cannot drop a bid to move
the price. Settlement is in FXRP (FAssets), with an XRPL delivery leg on the
roadmap. The project forks Flare's own `fce-orderbook` reference for the TEE
signing path and extension plumbing.

**What was newly built / ported / integrated / improved**
New for Flare during the program: the Vickrey clearing engine that never returns
losing amounts; the keccak commitment scheme bound at ingest and at clear;
on-chain commitment recording + set-digest binding (Go/Solidity byte-parity);
ECIES-sealed bids; wallet-signature-bound bids (closing the "sender at face
value" hole the reference orderbook documents in its own threat model);
selective disclosure; two-sided settlement with `reclaimLot`; the desk UI.
Also removed: the fork's order book and deposit/withdraw vault, ~11,000 lines
that this contract's direct settlement had made unreachable.
Improved on Flare's reference specifically: bids arrive as ciphertext (the
reference posts plaintext the proxy can read), requests are wallet-signed, and
the bid set is anchored on-chain (the reference keeps it in enclave memory and
loses it on restart).

Prior work, declared: we built this same sealed-bid thesis five times before, on
five other chains (Diam/iExec, Segel/Stellar, Sealed Pair/Sui, Samar/Zama,
Bisik/Canton). Each left the same open problem — the settler still sees the bids.
Buta is the build where an attested enclave finally removes that reader.

**Smart contract addresses / deployment details**
- Network: Coston2 (chain 114). TEE machine `0x848b3D86…5Bb0` is registered and PRODUCTION for extension 66009 — `getRandomTeeIds` resolves instead of reverting `TooMany()`. Enclave on the simulated-TEE path.
- `ButaInstructionSender`: `0xa03821ADE58EfC07bcB1Eacd4D96ced9C7cDF74D` — https://coston2-explorer.flare.network/address/0xa03821ADE58EfC07bcB1Eacd4D96ced9C7cDF74D
- Deploy runbook: `docs/DEPLOY.md`.

**Short roadmap / next steps**
1. Deploy to Coston2 and register a real attested TEE against the current FCC
   stable hostname instead of a rotating tunnel, swapping the simulated decryptor for the tee-node `/decrypt` path
   already wired behind the `Decryptor` interface.
2. Settle in real FXRP and add the XRPL delivery leg via Protocol Managed
   Wallets, so the winner takes the lot as native XRP.
3. Proof-of-funds via FDC to replace full escrow.
4. MPC clearing — the honest long-term answer to "the settler sees the openings."

---

## Encouraged extras (fill if true at submit time)

**Deployed on** Coston2. Machine registered and PRODUCTION; enclave simulated.
**Traction / testing** _[e.g. posted in the Flare hackathon Telegram, feedback
from …]_ — see the mentor-engagement pattern; do this before submitting.
