/**
 * The spoken script, and the only place timing lives.
 *
 * Each beat carries the words, how long they take, and which scene runs under
 * them. Subtitles are generated from the same array that drives the cuts, so a
 * caption can never describe a scene that is no longer on screen: change a
 * duration here and the picture, the words and the subtitle move together.
 *
 * Read it aloud in your own voice. Flare disqualifies AI voice and AI video,
 * which is why nothing in this project generates either. `seconds` is what a
 * normal reading pace takes for those words, measured at about 2.6 words per
 * second, so a recording made to this script lines up without editing. If your
 * take runs long, change the number here rather than trimming the audio.
 */

export interface Beat {
  /** What is on screen. See Scene in Demo.tsx. */
  scene:
    | "title"
    | "problem"
    | "fails"
    | "what"
    | "flow"
    | "clip-arrive"
    | "clip-book"
    | "clip-post"
    | "clip-seal"
    | "clip-settle"
    | "trim"
    | "solvency"
    | "clip-audit"
    | "proof"
    | "honest"
    | "close";
  /** Spoken, and shown as the subtitle. Kept to one or two sentences a beat. */
  say: string;
  seconds: number;
  /** Optional heading burned into the frame for this beat. */
  title?: string;
}

export const FPS = 30;

export const BEATS: Beat[] = [
  {
    scene: "title",
    title: "Buta",
    say: "A desk with a block to move has to show its size to find a price. That is how it gets front run.",
    seconds: 7,
  },
  {
    scene: "problem",
    title: "The problem",
    say: "Show the size to five counterparties, and one of them trades ahead of you. So price discovery for size stays in chat rooms.",
    seconds: 9,
  },
  {
    scene: "fails",
    title: "Why the obvious fixes fail",
    say: "A public contract cannot read a sealed bid, so it cannot compute a second price. And commit and reveal lets a loser stall the auction by never revealing.",
    seconds: 11,
  },
  {
    scene: "what",
    title: "Buta",
    say: "Buta is a sealed-bid desk on Flare Confidential Compute. Bids are encrypted to an attested enclave, and the party running the auction cannot read them.",
    seconds: 11,
  },
  {
    scene: "flow",
    title: "Four steps",
    say: "The maker posts a block and escrows the lot. Each bidder writes a commitment on chain. After the deadline the enclave opens the bids and signs the outcome. The contract checks it and settles.",
    seconds: 14,
  },
  {
    scene: "clip-arrive",
    say: "This is the deployed desk, talking to the live enclave. Everything you see here is read from the machine and from the chain.",
    seconds: 9,
  },
  {
    scene: "clip-book",
    say: "The book is public where it should be. Lot and deadline are in the open. The black bar is the maker's floor, encrypted to the enclave, and nobody else can read it.",
    seconds: 12,
  },
  {
    scene: "clip-post",
    say: "So here it is happening. A maker fills in a lot, a hidden floor and a deadline in minutes, presses post, and signs. The lot is escrowed on the contract and the book grows a row.",
    seconds: 16,
  },
  {
    scene: "clip-seal",
    say: "A second wallet opens that auction and seals a bid. The amount is encrypted in the browser, the commitment is computed here, the wallet signs, and what reaches the chain is a hash.",
    seconds: 16,
  },
  {
    scene: "clip-settle",
    say: "After the deadline, the enclave opens the bids and signs the outcome. The contract checks that signature against the set it recorded, then pays the maker and moves the lot in one transaction. That is a real settlement on Coston2, from this desk.",
    seconds: 18,
  },
  {
    scene: "trim",
    title: "The set cannot be trimmed",
    say: "Here is the part that is actually hard. The enclave signs over the commitments the contract recorded, not the ones it was handed. Drop an inconvenient bid and the digest stops matching, and the settlement reverts.",
    seconds: 15,
  },
  {
    scene: "solvency",
    title: "Solvency, without disclosure",
    say: "The enclave already holds the amounts, so it passes over a bidder who could not pay what they would owe, without telling anyone what they bid. Only the party that can read the bids can do that, and it is the one party that never repeats them.",
    seconds: 16,
  },
  {
    scene: "clip-audit",
    say: "Nothing here asks you to trust the page. Every identifier on the audit tab is a public read, checked in your own browser against the chain.",
    seconds: 10,
  },
  {
    scene: "proof",
    title: "It settles on Coston2",
    say: "It has settled on Coston2 more than once. Before the enclave was replaced, after it was rotated to a new machine, and once driven entirely through this desk.",
    seconds: 12,
  },
  {
    scene: "honest",
    title: "What is not done",
    say: "The enclave runs Flare's simulated path, so the key sits in the process rather than in hardware. It is a container behind a tunnel, not hosted infrastructure. Testnet tokens, and not audited.",
    seconds: 13,
  },
  {
    scene: "close",
    title: "Buta",
    say: "Every sealed-bid venue leaves one reader standing. Buta makes that reader an enclave that is not a party to the trade, cannot be handed a doctored bid set, and keeps nothing.",
    seconds: 13,
  },
];

/** Frame ranges, derived once so the composition and the subtitles agree. */
export const TIMELINE = BEATS.reduce<{ beat: Beat; from: number; durationInFrames: number }[]>(
  (acc, beat) => {
    const from = acc.length ? acc[acc.length - 1].from + acc[acc.length - 1].durationInFrames : 0;
    acc.push({ beat, from, durationInFrames: Math.round(beat.seconds * FPS) });
    return acc;
  },
  [],
);

export const TOTAL_FRAMES = TIMELINE[TIMELINE.length - 1].from + TIMELINE[TIMELINE.length - 1].durationInFrames;
