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
    resolve: { alias: { buffer: "buffer/" } },
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
