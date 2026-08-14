import "@rainbow-me/rainbowkit/styles.css";

import { getDefaultConfig, RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { coston2 } from "./config/chain";
import { env } from "./config/env";
import { Desk } from "./pages/Desk";

// WalletConnect needs a real project id. Without one, RainbowKit still offered
// it, so every page load fired two requests at third parties with
// "placeholder-project-id" - a 403 from api.web3modal.org and a 400 from
// pulse.walletconnect.org, in the console of anyone who opened the desk - and
// the button behind them could never have worked. Injected wallets need no
// project id at all, so that is the whole list until one is configured.
const walletConnectId = env.walletConnectProjectId;
const config = getDefaultConfig({
  appName: "BUTA",
  projectId: walletConnectId || "injected-only",
  chains: [coston2],
  ...(walletConnectId
    ? {}
    : { wallets: [{ groupName: "Installed", wallets: [injectedWallet] }] }),
});

const queryClient = new QueryClient();

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme({ accentColor: '#CE1414', accentColorForeground: '#F4F4F0', borderRadius: 'none', fontStack: 'system' })}>
          <Desk />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
