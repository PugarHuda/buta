/**
 * Coston2 token addresses for settlement and delivery.
 *
 * FXRP is the real FAssets token on Coston2; USDT0 is the quote side. Both are
 * env-overridable so a fresh deploy or a mock-token run can point elsewhere
 * without a rebuild. When the desk settles for real, the maker escrows FXRP as
 * the lot and the winner pays USDT0 as the clearing price — the two-ledger
 * story starts here and finishes with the XRPL delivery leg (roadmap).
 */

import { env } from "./env";

/** FXRP on Coston2 (FAssets). Resolve via ContractRegistry in production; this
 *  is the current known deployment. */
export const FXRP = (env.fxrp ||
  "0x0b6A3645c240605887a5532109323A3E12273dc7") as `0x${string}`;

/** USDT0 on Coston2 — the quote/settlement token the winner pays in. */
export const USDT0 = (env.usdt0 ||
  "0xe7cd86e13AC4309349F30B3435a9d337750fC82D") as `0x${string}`;

export const TOKENS = {
  FXRP: { address: FXRP, symbol: "FXRP", decimals: 6, label: "FXRP" },
  USDT0: { address: USDT0, symbol: "USD₮0", decimals: 6, label: "USD₮0" },
} as const;

export type TokenKey = keyof typeof TOKENS;
