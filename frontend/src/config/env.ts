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
  /** Settlement/delivery token overrides (Coston2 FXRP / USDT0). */
  fxrp: import.meta.env.VITE_FXRP as string || "",
  usdt0: import.meta.env.VITE_USDT0 as string || "",
} as const;
