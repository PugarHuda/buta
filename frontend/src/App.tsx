import "@rainbow-me/rainbowkit/styles.css";

import { getDefaultConfig, RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { coston2 } from "./config/chain";
import { env } from "./config/env";
import { ToastProvider } from "./components/ui/Toast";
import { Desk } from "./pages/Desk";

const config = getDefaultConfig({
  appName: "BUTA",
  projectId: env.walletConnectProjectId || "placeholder-project-id",
  chains: [coston2],
});

const queryClient = new QueryClient();

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme({ accentColor: '#CE1414', accentColorForeground: '#F4F4F0', borderRadius: 'none', fontStack: 'system' })}>
          <ToastProvider>
            <Desk />
          </ToastProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
