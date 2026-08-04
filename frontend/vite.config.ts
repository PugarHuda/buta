import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const upstream = env.VITE_PROXY_UPSTREAM || "http://localhost:6674";
  return {
    // The desk lives at /dashboard and the landing page at /, in ONE
    // deployment. They were two Vercel projects on two domains, which meant the
    // landing had to send people off-site to reach the product and neither page
    // could link to the other with a relative href.
    base: "/dashboard/",
    plugins: [react()],
    define: { global: "globalThis" },
    resolve: {
      alias: {
        buffer: "buffer/",
        // ecies-geth ships a WebCrypto build and a Node build, and its
        // package.json declares no "browser" field — so the bundler took the
        // Node one, Vite externalised its `crypto` import, and sealing a bid
        // died on "(0, crypto_1.randomBytes) is not a function". The desk has
        // no other way to encrypt an opening to the enclave, so that is the
        // whole product failing at its one irreplaceable step. Nothing said so:
        // the deployed desk has no enclave to reach, so no one ever got far
        // enough to see it. Point at the browser build explicitly.
        "ecies-geth": "ecies-geth/dist/lib/src/typescript/browser.js",
      },
    },
    optimizeDeps: { include: ["buffer", "ecies-geth"] },
    server: {
      proxy: {
        "/direct": { target: upstream, changeOrigin: true },
        "/state": { target: upstream, changeOrigin: true },
        "/action": { target: upstream, changeOrigin: true },
        "/info": { target: upstream, changeOrigin: true },
      },
    },
  };
});
