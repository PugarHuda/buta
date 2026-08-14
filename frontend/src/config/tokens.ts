/**
 * Coston2 token addresses for settlement and delivery.
 *
 * FXRP is the real FAssets token on Coston2; USDT0 is the quote side. Both are
 * env-overridable so a fresh deploy or a mock-token run can point elsewhere
 * without a rebuild. When the desk settles for real, the maker escrows FXRP as
 * the lot and the winner pays USDT0 as the clearing price - the two-ledger
 * story starts here and finishes with the XRPL delivery leg (roadmap).
 */

import { env } from "./env";

/** FXRP on Coston2 (FAssets). Resolve via ContractRegistry in production; this
 *  is the current known deployment. */
export const FXRP = (env.fxrp ||
  "0x0b6A3645c240605887a5532109323A3E12273dc7") as `0x${string}`;

/**
 * The quote token the winner pays in.
 *
 * This was 0xe7cd86e1…C82D, which has NO CODE on Coston2 - nothing is deployed
 * there. Every on-chain block the desk posted escrowed a lot against a
 * settlement that could not happen: relayClearing calls transferFrom on an
 * address that is not a contract. It went unseen because the settlements that
 * proved this system works were FXRP/FXRP, posted by scripts/onchain-loop.ts,
 * which never reads this.
 *
 * A mintable TestToken now, deployed by scripts/deploy-quote-token.mjs, and the
 * post form refuses to escrow anything if this address has no code.
 */
export const USDT0 = (env.usdt0 ||
  "0x07c3a88878f9fc0fc79b3d693d24c3d5d71b365e") as `0x${string}`;

export const TOKENS = {
  FXRP: { address: FXRP, symbol: "FXRP", decimals: 6, label: "FXRP" },
  USDT0: { address: USDT0, symbol: "USD₮0", decimals: 6, label: "USD₮0" },
} as const;

export type TokenKey = keyof typeof TOKENS;
