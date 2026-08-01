# The four things left, and what each actually needs

Written after checking rather than guessing. Two of these are yours because they
need an account; two are design work with a decision already made.

---

## 1. A static hostname (yours — 10 minutes)

The machine is PRODUCTION right now, published through a rotating quick tunnel
that `scripts/tunnel-keeper.sh` republishes whenever it moves. That works and it
is running. A static domain is better because it stops costing gas every
rotation and removes a minute of unreachability each time.

**ngrok, free tier, no domain purchase:**

1. Sign up: <https://dashboard.ngrok.com/signup> — Google or GitHub is fine.
2. Copy the authtoken from
   <https://dashboard.ngrok.com/get-started/your-authtoken> and run:

   ```
   "$USERPROFILE/AppData/Local/Microsoft/WinGet/Packages/Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe/ngrok.exe" config add-authtoken <TOKEN>
   ```

3. Claim the one free static domain at
   <https://dashboard.ngrok.com/domains> → **Create Domain**. It looks like
   `something.ngrok-free.app`.

4. Then, and this is the whole of it:

   ```bash
   ./scripts/tunnel-register-ngrok.sh something.ngrok-free.app
   ```

**Why a static domain and not a random URL.** Data providers push the
availability check to the hostname written on-chain. A random ngrok URL changes
on restart, the on-chain record goes stale, and the machine silently drops out
of PRODUCTION. Quantic's pinned message says this is why machines are sitting at
INITIALIZED with dead hostnames.

Stop the keeper once the static domain is live — two things republishing the
same record will fight.

---

## 2. Hardware attestation (yours — half a day, and probably not worth it)

Flare have said twice, in writing, that this is not required:

> "you do not need to deploy your own confidential space — you can run your FCE
> on any machine which is proxied for use in the Coston2 network (this is
> 'simulated', you don't need a full production deploy for the bounties)"
> — Tim Rowley, 28 July

> "We will accept Coston2 simulated approach, no worries." — Kristaps

If you want it anyway, the shape is:

1. A GCP project with billing, and the Confidential Computing API enabled.
2. A Confidential Space VM — **Intel TDX**, `c3-standard-4` or larger, image
   family `confidential-space-debian-12`.
3. Push the extension image to Artifact Registry, and set the workload policy so
   the launch policy allows only the env vars the image declares (`LOG_LEVEL`,
   `PROXY_URL`, `INITIAL_OWNER`, `EXTENSION_ID` — see tee-node
   `docs/deployment.md`).
4. `MODE=0` instead of `1`. The node then fetches attestation tokens from the
   Confidential Space launcher rather than simulating them.
5. Register with `SIMULATED_TEE=false`.

The honest cost/benefit: it is a day of GCP plumbing, it costs money to leave
running, and the judges have said it earns nothing. **Spend the day on the video
instead.**

---

## 3. The XRPL delivery leg — N10.5 says do NOT build it

Checked before designing anything, which is the rule that has already saved this
project twice.

Flare's Protocol Managed Wallets are **not** in the ContractRegistry, which is
why a name lookup finds nothing. They live in the FCC diamond, as facets:

```
WalletManagerFacet
WalletKeyManagerFacet
WalletProjectManagerFacet
WalletBackupManagerFacet
WalletProjectPauseFacet
```

So XRPL custody, key management, backup and per-project pause are **already
Flare's**, on the same diamond our extension is registered in. Building our own
would duplicate protocol infrastructure — the exact thing that got another
project shut down by Tim Rowley, and the reason we did not rebuild the
MintingTagManager either.

**The design, therefore:** the winner's lot is delivered by asking the diamond's
wallet facets to sign an XRPL payment from a project wallet, not by holding keys
ourselves. The enclave already proves it may act (it signs the clearing); the
wallet facets already decide whether that signature may move funds. Our part is
one call and the plumbing to wait for it — small, and only because the hard part
is not ours.

Not implemented. It needs a wallet project created on the diamond and an XRPL
account funded through it, which is a setup step rather than a code step, and it
touches settlement three weeks after settlement was last tested.

---

## 4. Proof-of-funds via FDC — the design, and why it is not built

The idea: instead of escrowing the full clearing price, a bidder proves they
hold the funds. The screen would then be evidence rather than a balance read.

**How it would work.** `Payment`/`BalanceDecreasingTransaction` are the wrong
attestation types; the right one is an `EVMTransaction` or a balance proof
against the FXRP contract at a stated block. The bidder requests an attestation
that `balanceOf(bidder) >= X` at block N, hands the proof in with the bid, and
the enclave verifies it against `FdcVerification` before ranking.

**Why it is not built.** Three reasons, in order of weight:

1. It touches `commitBid`, which is the one path tested end to end on-chain, at
   a moment when there is no time to re-test it properly.
2. `ClearScreened` already solves the failure it was meant to solve — a winner
   who cannot pay is passed over, and that is wired and tested. Proof-of-funds is
   a better version of a problem that is no longer bleeding.
3. A balance proof at block N says nothing about block N+1. It reduces escrow
   without removing the risk, so it is an improvement, not a fix — and improvements
   do not justify touching tested settlement code this late.

Roadmap, not backlog. The distinction matters: this is deliberate, not pending.

---

## 5. MPC clearing — the honest long-term answer

Stated in the submission as the answer to "the settler still sees the openings",
and it is. Writing down the shape so the claim is not hand-waving.

**The problem it solves.** Today the enclave decrypts every bid. That is safe
against the operator, the maker and us, because the code hash is attested and
the amounts never leave — but it is not safe against a compromised enclave. One
machine sees everything.

**The shape.** Split the clearing across n enclaves so no single one holds a
whole bid:

- The bidder secret-shares their amount to n enclaves rather than encrypting to
  one. Shamir over a prime field is enough; the amounts are uint64.
- Ranking is the hard part — comparison is expensive in MPC. A practical
  compromise is a bucketed comparison: bids are compared within price bands,
  which leaks the band and not the amount, and the band is public anyway once
  the clearing price is announced.
- The outcome is reconstructed only for the winner and the second price, which
  are exactly the two values already public.

**Why it is research and not a sprint.** The comparison protocol is where all
the difficulty is, `getRandomTeeIds` already hands out one machine at a time so
the n-of-n orchestration does not exist yet, and a wrong MPC implementation
fails silently rather than loudly. Six weeks with someone who has done it before,
not twelve days.

**What makes the claim credible today:** the clearing engine already takes the
recorded set and returns only `(winner, price, digest)`. Everything else is
internal. Swapping how the ranking is computed does not change that interface —
which is the property that makes the roadmap item real rather than aspirational.
