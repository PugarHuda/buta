# Buta — demo script (~3 minutes)

Record in **your own voice** — AI voice/video disqualifies (Flare rule, stated in
the hackathon group). Screen-record with OBS or the built-in recorder. Aim for
2:45–3:15. Each beat has a **shot** (what's on screen / what you click) and a
**say** (read it in your words, don't recite verbatim).

The whole run below is the live rail: real Coston2, real FXRP, and a settlement
that moves money. `node scripts/settle-from-browser.mjs` drives beats 2 through 5
through the actual pages and asserts each one against the chain rather than
against what the page says. Run it once before you press record: if it passes,
the demo you are about to perform works, on this contract, today.

If the stack will not come up in time, `BUTA_ALLOW_DIRECT_AUCTION=1 go run
./cmd/dev` plus `node scripts/seed.mjs` gives a full book on a local facade —
but it signs nothing, so beat 5 cannot happen. Record the on-chain rail.

**What is live while you record**

| | |
|---|---|
| Contract | [`0xa03821ADE58EfC07bcB1Eacd4D96ced9C7cDF74D`](https://coston2-explorer.flare.network/address/0xa03821ADE58EfC07bcB1Eacd4D96ced9C7cDF74D) |
| FCC extension | **66009** |
| TEE machine | whatever `node scripts/health.mjs` prints — it changes |

---

## Setup before recording

```bash
# 1. the enclave, the proxy and redis
cd buta
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d

# 2. a public hostname for the machine, republished on-chain when it moves
./scripts/tunnel-keeper.sh          # leave this running in its own terminal

# 3. register the machine, then point the contract at it
EXT_PROXY_HOST_URL=https://<the host the keeper printed> ./scripts/post-build.sh
source config/extension.env                    # INSTRUCTION_SENDER, EXTENSION_ID
source .env                                    # DEPLOYMENT_PRIVATE_KEY
cast send --chain 114 "$INSTRUCTION_SENDER" "setTeeAddress(address)" <the new machine> \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --private-key "$DEPLOYMENT_PRIVATE_KEY"
# --chain 114 is not optional: .env sets CHAIN=coston2, which cast rejects as a chain name.

# 4. prove all three agree before you waste a take
node scripts/health.mjs             # must say healthy
npm run verify:submission           # must say 0 failed

# 5. the desk
cd frontend && npm run dev          # http://localhost:5173
```

**Step 3 is two commands and both are needed.** Registering the machine makes it
PRODUCTION; it does **not** tell the contract to trust it. Skip `setTeeAddress`
and everything still reads healthy — machine PRODUCTION, alone in the active
set, published URL answering — and only the settle beat fails, with
`BadTeeSignature()`, on camera. `verify:submission` checks this now; that is why
it is in the list.

**If a previous machine is still active, retire it first.** Two in the set means
`getRandomTeeIds` hands out either, so roughly half the instructions go to an
address nobody is listening on and nothing reverts to say so — the desk simply
never gets its clearing back. `health.mjs` names the stray;
`node scripts/retire-machine.mjs <address>` pauses it.

Have MetaMask on Coston2 with **two funded accounts**: a maker holding FXRP for
the lot, and a bidder holding the quote token. FXRP reverts
`CannotTransferToSelf`, so they genuinely have to be different wallets.

---

## 0 · Cold open — the landing page (0:00–0:30)

**Shot.** Open **https://buta-desk.vercel.app**. Let the hero render. Move the
mouse slowly across the ledger plate so the red reticle tracks it. Scroll once to
the "who still reads the bids" table.

**Say.** "Desks that move size don't trade on public order books, because the
moment your bids are visible, the market front-runs them. So block trades happen
in chat rooms — opaque, and you have to trust a desk with the spread. Every
on-chain attempt to fix this leaves one reader standing: whatever clears the
auction can read every bid. Zero-knowledge, threshold keys, private ledgers —
none of them remove that reader. An attested enclave does. That's Buta."

---

## 1 · The desk, talking to a real enclave (0:30–0:50)

**Shot.** Go to `localhost:5173`. Let the book load. Point at the masthead
status — it says the extension is in production because the browser just read
that from the diamond, not because the page says so.

**Say.** "This is the desk, and it's talking to an enclave that's registered
on Flare's confidential compute — the browser checks that against the chain on
load, it isn't a badge I drew. Open auctions, sizes, deadlines. Read the first
line: nobody can read a bid before it clears — not the maker, not the operator,
not us. Losing amounts are never revealed at all. Let me show you why that's
true, not just a claim."

---

## 2 · Post a block (0:50–1:10)

**Shot.** Tab **Post a block**. Switch the rail toggle to **On-chain** — this is
the beat where a demo silently becomes a local book if you forget. Lot `2` (base
units), hidden reserve `0.5` (quote units), open for a few minutes. Click **Post
block**, sign in MetaMask, wait for the row to appear. Point at the reserve field
as you say the line about it.

**Say.** "As a maker I post a block of FXRP. My reserve — my floor price — is
encrypted to the enclave before it leaves the page. Bidders never see it. If
only one bidder shows up, they pay exactly this and no less. That's a real
transaction: the lot is now escrowed in the contract."

---

## 3 · Seal a bid — the core (1:10–1:55)

**Shot.** Switch MetaMask to the second account. Click the RFQ row you just
posted. Tab **Seal a bid**, type an amount above the reserve, e.g. `0.9`, then
**Seal on-chain instead** — again, the on-chain rail, not the local one.
MetaMask pops twice if this wallet's allowance is short: once to approve the
payment, once for the bid itself. Sign both. (Run the wallet dry once before
recording, so the approval pop is on camera — it is the beat that says winning
means paying.) When the receipt appears, hover the commitment and nonce.

**Say.** "Now I bid, as a different desk. Watch what leaves my browser. The
amount, a nonce, and my wallet signature get ECIES-encrypted to the enclave's
public key — so the operator relaying this sees only ciphertext, never my
number. My wallet signs it, so nobody can bid as me. What lands on-chain is this
commitment: a hash that reveals nothing. Sealing also approves the payment,
because winning means paying — I'm not asking the seller to trust that I'll be
good for it. Keep that nonce: it's how I prove my bid later, to whoever I
choose."

*(Proof on camera: open devtools Network before signing and point at the
`commit_bid` request body — the `ciphertext` field, and no amount anywhere in
it.)*

---

## 4 · Clear at the second price (1:55–2:25)

**Shot.** Back to the maker's window. When the deadline block passes, click
**Request clearing on-chain**. Wait for the signed outcome to land — it takes a round of
data-provider votes, so give it a minute; don't cut here, let the wait be
visible. The receipt appears: winner, clearing price, "sealed forever".

**Say.** "Deadline's up — anyone can trigger the clear, it never waits on the
maker. The instruction goes on-chain, Flare's data providers deliver it to the
enclave, the enclave opens the bids, ranks them, and signs an outcome. It clears
at the Vickrey second price: with one bidder, that's my hidden reserve, so the
winner pays the floor and not their own number. Winner and price are public —
they have to be, that's the trade. The losing amounts, the winner's own bid, and
the reserve are sealed forever."

---

## 5 · The transaction that moves money (2:25–2:45)

**Shot.** Click **Settle on-chain**. Sign. When it confirms, open the tx on
**coston2-explorer.flare.network** and point at the two transfers in one
transaction.

**Say.** "And this is the only button that moves money. The contract checks the
enclave's signature, and checks that the clearing was computed over exactly the
bid set it recorded — so an auctioneer can't quietly drop a bid to move the
price, even with a perfectly valid signature. Then it pays the maker and
delivers the lot to the winner in one transaction. Delivery versus payment.
Neither leg can land alone."

---

## 6 · Selective disclosure — the twist (2:45–3:05)

**Shot.** Tab **Portfolio**. In "Disclose a bid," enter the RFQ, the amount, and
the nonce from the receipt. Click **Build disclosure**. Paste it into "Verify a
disclosure." Click **Verify** — the green **VERIFIED** line appears.

**Say.** "Here's the part I like. The winner paid the second price, so their
real, higher bid stays hidden on-chain forever. But they can still prove exactly
what they bid — to an auditor, a regulator, a counterparty — and they can't lie:
any other number gives a different commitment. Private price discovery, with a
receipt only the people who need it can read."

---

## 7 · Close (3:05–3:20)

**Shot.** Back to the landing hero, or the honest-scope section.

**Say.** "A Vickrey auction can't be run honestly on a transparent chain — you'd
have to publish every bid to clear it. An attested enclave is the first thing
that computes the clearing correctly and holds the bids where no interested
party can read them. That's Buta, on Flare Confidential Compute, built for
Summer Signal. It isn't audited and it isn't for real assets yet — but every
claim in this demo, you just watched happen on Coston2."

---

## Optional beat, if you want the strongest 20 seconds in the video

Between beats 5 and 6, replace the enclave on camera:

```bash
docker compose -f docker-compose.yaml -f docker-compose.coston2.yaml up -d --force-recreate extension-tee
```

**Say.** "A TEE identity is meant to be ephemeral — this one just came back as a
different machine with a different key, which is exactly what re-attestation
means. Our first deployment pinned the enclave's address permanently, and the
day that container was replaced, the contract could never settle another auction
again. So the desk re-attests the new machine and rotates to it — and it can only
rotate to a machine the chain says passed the availability check. Then it settles
again."

Then: `post-build.sh`, `setTeeAddress`, and post/seal/clear/settle once more.
It costs about four minutes of footage. Cut it down to the recreate, the rotate,
and the settlement that follows.

---

## Recording it as a driver instead of by hand

`node scripts/settle-from-browser.mjs` runs beats 2 through 5 against the real
desk in a real browser, with two wallets that broadcast for real, asserting each
step against the chain rather than against what the page says. It is a one-off
driver, not part of any suite, because it spends testnet FXRP and gas every run.

Run it headed (`HEADLESS=0`) and it is a usable screen capture for those beats.
The wallet signatures and the disclosure (beat 6) are still worth doing by hand
— a judge can tell the difference, and the MetaMask popups are the part that
makes it feel real.
