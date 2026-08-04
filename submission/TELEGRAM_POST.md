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
> — desk: https://buta-desk.vercel.app/dashboard
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

---

## Second post — the register-tee finding (worth its own message)

This one is not about us, and it is the more useful of the two. Post it
separately, plainly, without the project pitch attached.

> If your TEE machine is stuck at INITIALIZED and the availability check keeps
> coming back 404, check what URL is actually on-chain:
>
> `cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE "getTeeMachine(address)((address,address,string))" <teeId>`
>
> Re-running post-build with a new EXT_PROXY_HOST_URL does **not** change it.
> RegisterNode sees the machine already exists, skips PreRegistration — which is
> the only thing that writes the URL — and goes straight to a fresh attestation.
> So the check keeps being pushed to the old hostname no matter what your env
> says.
>
> What worked for me: `MachineManagerFacet.updateTeeMachineSettings(teeId,
> proxyId, url)`. Owner-only. It rewrites the proxy id too, which matters if you
> changed PROXY_PRIVATE_KEY away from the scaffold default — the check is
> verified against that identity. After that, `-command Rap` and it went to
> PRODUCTION.
>
> Two smaller ones from the same afternoon: the node needs `CHAIN_ID` in its env
> or it fails every signature with "could not get chain id", which reaches the
> proxy as "signature must be 65 bytes, got 0" and looks like a proxy bug. And
> tee-proxy v0.0.19 rejects a v0.0.22 node as "invalid signature"; v0.0.20 does
> not.

Why post it: it costs nothing, it is checkable, and Quantic's pinned message
says machines are sitting at INITIALIZED with dead hostnames — which is exactly
this. Mentors notice people who make the room work better.

Do not attach the pitch. A useful message that is also an advert reads as an
advert.
