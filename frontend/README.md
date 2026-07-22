# Orderbook Frontend

A classic orderbook trading UI for the Flare TEE orderbook extension. Connect a wallet, deposit, trade, and withdraw — all from a browser on Coston2 (chain ID 114).

## Quickstart (local dev)

Prerequisites: the orderbook extension must be running locally (see the parent README).

```bash
cd frontend
cp .env.example .env
npm install
npm run dev                 # opens http://localhost:5173
```

That's it. Vite's dev server proxies `/direct`, `/state`, `/action` to the TEE proxy directly, so the browser only sees same-origin requests — **no CORS proxy is needed for local dev**.

If your setup isn't standard, tune `.env`:

- `VITE_PROXY_UPSTREAM` — the TEE proxy URL vite forwards to.
  - Docker mode (default): `http://localhost:6674`
  - Local Go process mode (`start-services.sh --local`): `http://localhost:6664`
- `VITE_TEE_PROXY_URL` — leave **empty** for dev (frontend uses relative URLs → vite proxy). Only set this when serving a built bundle outside vite (see Production).

If the banner "TEE proxy unreachable" appears at the top of the page, the dev server can't reach the upstream proxy. Check `VITE_PROXY_UPSTREAM` and that the TEE proxy is actually running (`docker compose ps` or `./scripts/start-services.sh`).

## Dev against a remote TEE proxy

If the proxy lives somewhere else (e.g. a GCP deployment) and you still want to use `npm run dev`, just point `VITE_PROXY_UPSTREAM` at it. Vite forwards server-side, so the browser stays same-origin and no CORS is involved.

```
VITE_PROXY_UPSTREAM=https://tee-proxy-coston2-orderbook.flare.rocks
VITE_INSTRUCTION_SENDER=0x...   # if the live INSTRUCTION_SENDER differs from generated.ts
VITE_TEE_PROXY_URL=             # leave empty
```

## Production / serving a built bundle

Once the frontend is built (`npm run build`), there's no more vite dev server in the middle — the static bundle runs in the browser and makes cross-origin requests directly. The TEE proxy doesn't emit CORS headers. Two ways to handle that:

### Option A — Vercel (recommended for remote proxy)

`vercel.json` (included in this repo) rewrites `/direct`, `/state`, `/action` server-side to the remote TEE proxy, so the browser stays same-origin. **Update the destination URLs in `vercel.json` if your proxy moves.**

On the Vercel project, set:

| Variable | Value |
|---|---|
| `VITE_TEE_PROXY_URL` | *(empty)* — use the rewrites |
| `VITE_INSTRUCTION_SENDER` | the live `0x...` address |
| `VITE_DIRECT_API_KEY` | the key configured on the remote proxy |
| `VITE_WALLETCONNECT_PROJECT_ID` | your project ID |
| `VITE_SHOW_FAUCET` | `false` for a real deployment |

Vercel caveat: the `prebuild` hook runs `sync-config`, which expects the parent `orderbook/` repo. If you deploy the `frontend/` directory alone, sync-config will silently overwrite `generated.ts` with empty values. Workarounds: (a) drop `src/config/generated.ts` from `.gitignore` and commit it before pushing, then remove the `sync-config &&` prefix from the `build` npm script; or (b) deploy from the monorepo root and set Vercel's root directory to `frontend/`.

### Option B — cors-proxy sidecar (local / self-hosted)

```bash
# From the orderbook root:
go run ./cmd/cors-proxy --target http://localhost:6664 --listen :6670 --allow-origin http://your-frontend-origin
VITE_TEE_PROXY_URL=http://localhost:6670 npm run build
npx serve dist
```

> **Port note:** Chrome blocks ports 6665–6669 (IRC range) as "unsafe" — use 6670+ for the cors-proxy.

## Environment Variables

| Variable | Default (dev) | Description |
|---|---|---|
| `VITE_TEE_PROXY_URL` | *(empty)* | Leave empty in dev and on Vercel (uses vite proxy / rewrites). Set to cors-proxy URL for the sidecar flow. |
| `VITE_PROXY_UPSTREAM` | `http://localhost:6674` | Where vite's dev proxy forwards TEE calls. Point at the remote proxy URL for remote dev. |
| `VITE_DIRECT_API_KEY` | `test-api-key-change-me` | API key for `/direct` endpoint. |
| `VITE_SHOW_FAUCET` | `true` | Show the test-token faucet button. |
| `VITE_WALLETCONNECT_PROJECT_ID` | *(empty)* | WalletConnect project ID. |
| `VITE_INSTRUCTION_SENDER` | *(empty)* | Override for the deployed `INSTRUCTION_SENDER` contract address. Falls back to `generated.ts`. |

## Config Sync

`npm run sync-config` reads deployed addresses and pair config from the parent repo and writes `src/config/generated.ts`. This runs automatically on `dev` and `build`.

The generated file includes:
- `EXTENSION_ID` — from `config/extension.env`
- `INSTRUCTION_SENDER` — the deployed contract address
- `BASE_TOKEN` / `QUOTE_TOKEN` — from `config/test-tokens.env`
- `PAIRS` — from `config/pairs.json`
- `INSTRUCTION_SENDER_ABI` — from the Foundry build output

## Extract as Standalone Repo

This frontend is designed to be self-contained. To extract it:

```bash
cp -r frontend ../my-orderbook-ui
cd ../my-orderbook-ui
rm -rf node_modules
git init
```

Then hand-edit `src/config/generated.ts` with your deployed addresses:

```ts
export const EXTENSION_ID = "your-extension-id";
export const INSTRUCTION_SENDER = "0xYourContractAddress";
export const BASE_TOKEN = "0xBaseTokenAddress";
export const QUOTE_TOKEN = "0xQuoteTokenAddress";
export const PAIRS = [{ name: "FLR/USDT", baseToken: "0x...", quoteToken: "0x..." }];
export const INSTRUCTION_SENDER_ABI = [ /* ... */ ];
```

Remove `scripts/sync-config.ts` and the `sync-config` npm script. The rest works standalone.
