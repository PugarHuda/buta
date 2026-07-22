# Telegram progress post — draft

Post this in the Flare hackathon group. Follows the pattern that worked for
Harbor: show something real, name the mechanism, ask for feedback, tag a mentor.
Rewrite in your own words before posting — Kristaps has told people directly to
drop the AI-polished phrasing ("use your own words, less AI jargon"). Keep it
short and human.

---

**Draft (edit to sound like you):**

> Hey all — sharing progress on **Buta**, our Bounty 2 build.
>
> It's a sealed-bid OTC desk on FCC where the auctioneer literally can't read
> the bids. Bidders encrypt their bid to the enclave; it clears at the Vickrey
> second price and forgets the rest. Winner + price are public, but every losing
> amount and the winner's own bid stay sealed. A bidder can still prove their
> exact bid to an auditor later without it going public.
>
> The part I'm proud of: the contract records each bid's commitment on-chain
> *before* anyone knows the amount, and refuses any clearing whose set doesn't
> match — so the auctioneer can't quietly drop a bid to move the price. It's a
> revert, not a promise.
>
> Live on Coston2 (simulated-TEE path), contract verified on the explorer:
> — desk: https://buta-desk.vercel.app
> — code: https://github.com/PugarHuda/buta
> — contract: 0x20d9CcAA7140bf38AD91D2F102bA996417798e8f
>
> Question for the FCC folks: for the real (non-simulated) round trip, is the
> current register flow against the new FlareTeeManager diamond
> (`0x1a9C4A0f…`) stable now, or still settling? Want to do the on-chain TEE
> registration but don't want to demo on a moving target. @kristapsgrinbergs
> @oxQuantic — any feedback on direction welcome.

---

**Why this shape:**
- Opens with what it is, in one breath.
- Names the one non-obvious mechanism (on-chain commitment set → un-trimmable),
  which is what makes it more than "another dark pool."
- Shows live artifacts (desk + verified contract + repo) — Flare amplifies
  builders with demoable work.
- Ends with a specific, useful question that invites a mentor reply and signals
  you've read the FCC internals. Mentors engage with specifics, not "what do you
  think?"
- Avoids the words "dark pool" and "order matching" — those are Dusk/DarkStop's
  lane; Buta is sealed-bid Vickrey.
