# Buta desk

The browser half of the sealed-bid desk: post a block, seal a bid, clear at the
second price, disclose the outcome. Coston2 (chain 114).

This directory arrived as the reference order book's frontend. What survives is
the wallet plumbing; the book itself, its deposit and withdraw rails and forty
unreachable components went with the vault. A file here still talking about
trading pairs and a book is a leftover, and a bug.

## Local dev

The desk needs the extension running. From the repo root:

```bash
BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev      # simulated TEE, in-process key
cd frontend && npm install && npm run dev         # http://localhost:5173
```

Vite proxies `/direct`, `/state` and `/action` to the extension proxy, so the
browser only makes same-origin requests and no CORS proxy is involved.

- `VITE_PROXY_UPSTREAM` — where vite forwards. `http://localhost:6674` for the
  docker path, `http://localhost:6664` when the Go processes run directly.
- `VITE_TEE_PROXY_URL` — leave empty in dev. It is only for serving a built
  bundle outside vite.

"EXTENSION OFFLINE" at the top of the page means the desk could not reach the
proxy and is showing demo data. That is the honest state, not a crash.

## What the deployed desk does

<https://buta-app.vercel.app> runs on demo data, and says so on the page.

There is no public proxy to point it at: no TEE machine is registered for
extension 65642, so nothing on-chain can be served yet. The live flow runs
locally, which is what the banner tells you.

Two things were deleted rather than left pointing somewhere plausible:

- **`vercel.json`.** It rewrote `/direct`, `/state` and `/action` to
  `tee-proxy-coston2-orderbook.flare.rocks` — Flare's own reference orderbook
  proxy. Someone else's infrastructure, serving a different extension, so every
  BUTA instruction would have come back "unsupported op type". The rewrites were
  inert in production, which is exactly why they were worth removing instead of
  leaving armed for the next redeploy. If Buta ever gets a proxy, add rewrites
  pointing at **that**.
- **WalletConnect.** With no real `VITE_WALLETCONNECT_PROJECT_ID`, RainbowKit
  still offered it, so every page load fired a 403 at `api.web3modal.org` and a
  400 at `pulse.walletconnect.org` carrying `placeholder-project-id`, and the
  button behind them could never have worked. Injected wallets need no project
  id, so they are the whole list until one is set — set the variable and
  WalletConnect comes back on its own.

## Environment

| Variable | Default | What it is |
|---|---|---|
| `VITE_TEE_PROXY_URL` | *(empty)* | Full proxy URL when serving a built bundle. Empty in dev. |
| `VITE_PROXY_UPSTREAM` | `http://localhost:6674` | Where vite's dev proxy forwards. |
| `VITE_INSTRUCTION_SENDER` | *(from `generated.ts`)* | `ButaInstructionSender`. Coston2: `0x20d9CcAA7140bf38AD91D2F102bA996417798e8f` |
| `VITE_DIRECT_API_KEY` | *(empty)* | Key the proxy expects, if it wants one. |
| `VITE_WALLETCONNECT_PROJECT_ID` | *(empty)* | Optional. Unset means injected wallets only. |
| `VITE_SHOW_FAUCET` | `true` | Testnet faucet link. |

`npm run sync-config` writes `src/config/generated.ts` from the parent repo's
deployed addresses and Foundry build output. It runs on `dev` and `build`.
Deploying `frontend/` on its own leaves it with nothing to read, so commit
`generated.ts` or deploy from the repo root with the root directory set here.

## Checks

```bash
npx tsc --noEmit
npm run build
node ../../undelayed/qa/render.mjs https://buta-app.vercel.app
```

The last one renders the deployed page in Chromium and WebKit and fails on
console errors, horizontal overflow, text covered by something opaque, panels
still showing their loading state, and numbers that came out `NaN`. Checking a
built directory is not the same as checking the page people open — the deploy
config and the environment are only real once it is live. Both deletions above
were found that way.
