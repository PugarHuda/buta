# Buta — demo script (~3 minutes)

Record in **your own voice** — AI voice/video disqualifies (Flare rule, stated in
the hackathon group). Screen-record with OBS or the built-in recorder. Aim for
2:45–3:15. Each beat has a **shot** (what's on screen / what you click) and a
**say** (read it in your words, don't recite verbatim).

**Setup before recording**
```
cd buta && BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev     # facade on :6674
cd buta/frontend && node scripts/seed.mjs                   # a book that looks alive
cd buta/frontend && npm run dev                             # desk on :5173
```
Have MetaMask on Coston2 with a funded account for the live signature beat.

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

## 1 · The desk (0:30–0:50)

**Shot.** Go to the desk (`localhost:5173`). Let the seeded book load — cleared
receipts, a live whale block, a directed one. Hover the first line of copy.

**Say.** "This is the desk. Open auctions, sizes, deadlines. Read the first line:
nobody can read a bid before it clears — not the maker, not the operator, not us.
Losing amounts are never revealed at all. Let me show you why that's true, not
just a claim."

---

## 2 · Post a block (0:50–1:10)

**Shot.** Tab **Post a block**. Fill: pair `FXRP/USDT0`, lot `250000`, hidden
reserve `120000`, a deadline block. Click **Post block**. Point at the reserve
field as you say the line about it.

**Say.** "As a maker I post a block — 250,000 FXRP. My reserve, my floor price,
is encrypted. Bidders never see it. If only one bidder shows up, they pay exactly
this and no less. Posted — and from this moment, bids are sealed."

---

## 3 · Seal a bid — the core (1:10–1:55)

**Shot.** Select the RFQ you just posted. Tab **Seal a bid**. Type an amount,
e.g. `130450`. Click **Seal bid**. **MetaMask pops** — show the signature request,
sign it. When the receipt appears, hover the commitment and nonce.

**Say.** "Now I bid. Watch what leaves my browser. The amount, the nonce, and my
wallet signature get ECIES-encrypted to the enclave's public key — so the
operator relaying this sees only ciphertext, never my number. My wallet signs the
bid, so nobody can bid as me. What lands on-chain is this commitment — a hash that
reveals nothing. Keep that nonce: it's how I'll prove my bid later, to whoever I
choose."

*(If you want the proof-on-camera: open devtools Network tab before signing and
point at the `commit_bid` request body — the `ciphertext` field, no amount in it.)*

---

## 4 · A second bid (1:55–2:10)

**Shot.** Switch MetaMask to a second account (or note you'd do this as another
trader). Seal a second bid on the same RFQ, a **lower** amount, e.g. `127900`.
Show the bid count tick up.

**Say.** "A second desk bids — lower. Two sealed bids on the book now. Neither can
see the other. Neither can I. Not even the machine clearing them can, until the
deadline."

---

## 5 · Clear at the second price (2:10–2:40)

**Shot.** Click **Clear RFQ**. The clearing receipt appears. Point at each column:
winner, clearing price (the macro number), and the "Sealed forever" column.

**Say.** "Deadline's up — anyone can trigger the clear, it never waits on the
maker. The enclave ranks the bids and clears at the Vickrey second price: the
winner pays the runner-up's number, not their own. Winner and clearing price are
public. But look — the losing amounts, the winner's own bid, and the reserve are
sealed forever. The contract even refuses a clearing computed over any bid set it
didn't record, so the auctioneer can't quietly drop a bid to move the price."

---

## 6 · Selective disclosure — the twist (2:40–3:00)

**Shot.** Tab **Portfolio**. In "Disclose a bid," enter the winner's RFQ, amount,
and the nonce from the receipt. Click **Build disclosure**. Copy it into "Verify a
disclosure." Click **Verify** — the green **VERIFIED** line appears.

**Say.** "Here's the part I like. The winner paid the second price, so their real,
higher bid stays hidden on-chain forever. But they can still prove exactly what
they bid — to an auditor, a regulator, a counterparty — and they can't lie: any
other number gives a different commitment. Private price discovery, with a
receipt only the people who need it can read."

---

## 7 · Close (3:00–3:15)

**Shot.** Back to the landing hero, or the honest-scope section.

**Say.** "A Vickrey auction can't be run honestly on a transparent chain — you'd
have to publish every bid to clear it. An attested enclave is the first thing that
computes the clearing correctly and holds the bids where no interested party can
read them. That's Buta, on Flare Confidential Compute. Built for Summer Signal.
It's not audited and not for real assets yet — but every claim in this demo, you
just watched happen."

---

## If you record with Playwright instead of by hand

A driver is sketched at `frontend/scripts/record-demo.mjs`. It needs
`npm i -D playwright && npx playwright install chromium` (~150 MB), the facade +
seed running, and the desk on :5173. It drives beats 1–6 headed with a visible
cursor and writes `media/buta-demo.webm` for you to narrate over. The wallet
signature (beat 3) and disclosure (beat 6) are the two beats worth doing by hand
for authenticity.
