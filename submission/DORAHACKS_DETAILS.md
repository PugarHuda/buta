# Details field, ready to paste

Paste this into the BUIDL "Details" editor. It follows the hackathon's own
judging criteria in order: what the product is for, how Flare is used, whether
it works, what is new, and where it goes. No em dashes, plain sentences.

---

## The problem

A desk with a block of FXRP to move has to show the size to find a price. It
asks five counterparties, and one of them trades ahead of it. So price discovery
for size stays in chat rooms: slow, un-auditable, and resting on trusting
whoever holds the spread.

The obvious fixes do not work. A public contract cannot read a sealed bid, so it
cannot compute a fair clearing price. Commit and reveal does not rescue it: a
losing bidder who dislikes the outcome simply never reveals and stalls the
auction, and everyone who does reveal publishes their size.

## What Buta is

A sealed-bid OTC desk on Flare Confidential Compute where the party running the
auction cannot read the bids.

A maker posts a block. The lot is escrowed on the contract and the maker's floor
is ECIES-encrypted to an attested enclave. Each bidder writes a 32-byte
commitment on chain plus a ciphertext only the enclave can open. After the
deadline block the enclave decrypts, ranks, clears at the Vickrey second price,
signs the outcome, and forgets the amounts. The contract verifies that signature
and settles: the winner's payment to the maker and the lot to the winner, in one
transaction.

The winner and the clearing price are public, because that is the mechanism
working. Every losing amount, the winner's own bid, and the maker's reserve stay
sealed.

## Who it is for

OTC desks, treasuries and market makers clearing block trades in FXRP and other
Flare assets. Anyone for whom leaking order size before settlement is
unacceptable.

## How it uses Flare

Flare Confidential Compute is load-bearing, not namechecked.

- The clearing engine runs inside the TEE. Bids are encrypted to the enclave key
  the **diamond publishes**, read with `getRandomTeeIds` and `getPublicKey`, not
  to a key an operator serves, so the party relaying a bid cannot substitute the
  key it is sealed to.
- Instructions reach the enclave through the FCC diamond as extension 66009.
  `postRfq`, `commitBid` and `requestClearing` all dispatch that way.
- The contract verifies the enclave's signature over the result with a
  domain-separated `ecrecover` before it moves anything.
- Settlement is in FAssets: FXRP moves on both legs of the same transaction.

## The claim that is actually hard

**The bid set cannot be trimmed.** The enclave signs its outcome over a digest of
the commitments the contract recorded, not the ones it was handed. Drop an
inconvenient bid and the digest stops matching, and `relayClearing` reverts.

Without that check, whoever calls the clearing hands the enclave a subset, the
top bidder clears at its own ask, and the signature is still perfectly valid.
Both digests are pinned to the same cross-language test vector, computed
independently in Go and in Solidity.

**Solvency screening without disclosure.** A bidder with no funds wins, the
settlement transfer reverts, and the auction dies for the runner-up who could
have paid. The enclave already holds the decrypted amounts, so it reads balance
and allowance for the price that bidder would owe and passes them over. It tells
nobody, including the maker. Only the party that can read the bids can do that,
and it is the one party that never repeats them.

## Does it work

Yes, on Coston2, repeatedly, and you can check it without us.

- Contract `0xa03821ADE58EfC07bcB1Eacd4D96ced9C7cDF74D`, source-verified, FCC
  extension 66009, TEE machine registered and PRODUCTION.
- Settled delivery versus payment: `0x5a5f867f...`
- The enclave was deliberately replaced, the contract rotated to the new machine
  (`0x0783b99b...`), and it settled again afterwards (`0x5ca111a5...`).
- Settled from the deployed desk rather than a script: `0x55b07ad0...`
- `node scripts/onchain-status.mjs` verifies every claim above from public reads,
  with no key.

The deployed desk talks to the live enclave. Connect a Coston2 wallet and you can
post a block, seal a bid and settle it yourself. Every one of those is a contract
call signed by your own wallet. If the machine is down the page falls back to a
demo book and says so.

Tests: 24 Foundry tests on the contract, Go tests across the clearing engine and
the extension, including a leak test that drives every read command against a
full book and asserts that no amount escapes.

## What is new

Everything in this repository was built during the program, on a fork of Flare's
`fce-orderbook` reference extension. The central limit order book and the
deposit and withdraw vault that came with the fork were deleted rather than left
dormant: about eleven thousand lines removed, because a custody rail nobody can
enter reads like a feature.

Prior art is declared in full in SUBMISSION.md. This is the sixth build of the
same sealed-bid thesis, and the first where an attested enclave removes the
reader that every earlier one left standing.

## What is not done

Said plainly, because a reviewer would find it anyway.

The enclave runs Flare's simulated TEE path, so the decryption key sits in the
process rather than in hardware. The machine is a container behind a reserved
tunnel domain, not hosted infrastructure. Testnet tokens. Not audited.

On the last day we ran adversarial reviews against our own code and found six
things we could not fix without redeploying a contract that already carries this
submission's settlement history. They are written up in SUBMISSION.md with where
the fix belongs, including a set-divergence any address can trigger with one
transaction, and the reserve being the one input that is neither committed nor
digested.

## Next

1. Swap the simulated decryptor for the tee-node decrypt path, already wired
   behind an interface, on hosted hardware with a stable hostname.
2. Commit the reserve on chain so it is digested alongside the commitments.
3. An XRPL delivery leg so a winner can take the lot as native XRP.
4. Proof of funds through the FDC instead of full escrow.
