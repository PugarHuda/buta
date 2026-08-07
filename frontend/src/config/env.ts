/** Typed access to VITE_* env vars with defaults. */

export const env = {
  /** Base URL of the TEE proxy. Empty in a production bundle: the desk then
   *  shows the demo book rather than polling something that cannot answer. */
  teeProxyUrl: import.meta.env.VITE_TEE_PROXY_URL as string || "",
  /** API key for the /direct endpoint. */
  directApiKey: import.meta.env.VITE_DIRECT_API_KEY as string || "",
  /** WalletConnect project ID. */
  walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string || "",
  /** Override for the deployed ButaInstructionSender contract address.
   *  Falls back to the value baked into generated.ts by sync-config. */
  instructionSender: import.meta.env.VITE_INSTRUCTION_SENDER as string || "",
  /** FCC extension id. The desk asks the diamond which contract is bound to it,
   *  so this is the one identifier a redeploy has to change here. */
  extensionId: BigInt(import.meta.env.VITE_EXTENSION_ID as string || "66009"),
  /** Settlement/delivery token overrides (Coston2 FXRP / USDT0). */
  fxrp: import.meta.env.VITE_FXRP as string || "",
  usdt0: import.meta.env.VITE_USDT0 as string || "",
  /** Encrypt bids to the key the RELAY serves instead of the one the chain
   *  holds. Only for running your own enclave: cmd/dev registers nothing, so
   *  the registered key is a different enclave's and nothing it seals can be
   *  opened. Off by default because an operator serving its own key is the
   *  attack this exists to prevent. */
  allowUnverifiedTeeKey: import.meta.env.VITE_ALLOW_UNVERIFIED_TEE_KEY === "1",
} as const;
