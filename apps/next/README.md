# Unveil (Next.js)

The Unveil app rebuilt with Next.js and TypeScript on top of [`@unveil/sdk`](../../packages/sdk). Same screens and flow as the original `web/` app. All encryption and contract logic lives in the SDK; this app is only UI plus a small storage API.

## Run it

From the repo root:

```bash
npm install
cp apps/next/.env.example apps/next/.env.local   # then set NEXT_PUBLIC_CONTRACT_ID
npm run dev                                       # http://localhost:3000
```

`npm run dev` builds the SDK first, then starts Next.js. For a production build: `npm run build -w @unveil/next && npm run start -w @unveil/next`.

| Variable | |
|---|---|
| `NEXT_PUBLIC_CONTRACT_ID` | The deployed contract (`scripts/deploy.sh` prints it). |
| `NEXT_PUBLIC_TOKEN_SYMBOL` | `XLM` or `USDC`, for display. |
| `NEXT_PUBLIC_NETWORK` | `testnet` (default) or `mainnet`. |
| `DATA_DIR` | Where the storage API writes encrypted files (default `apps/next/data`). |

## Layout

```
app/
  api/blob/route.ts          POST: store bytes, return their SHA-256
  api/blob/[hash]/route.ts   GET: fetch bytes by SHA-256
  layout.tsx, page.tsx, globals.css
components/
  UnveilProvider.tsx         wallet (Stellar Wallets Kit), SDK client, toasts
  AnonPanel.tsx              camera, register, profile, incoming requests
  RequesterPanel.tsx         lookup, NDA, deposit, your requests, peephole viewer
  AuditPanel.tsx             every request on-chain
  ArbiterPanel.tsx           evidence key, disputes, evidence viewer
lib/
  blob-store.ts              disk storage used by the API routes
```

## Deploying

The storage API writes to disk, so it needs a host with a persistent volume (Render, Railway, Fly.io). On serverless hosts such as Vercel there's no persistent disk: replace the two functions in `lib/blob-store.ts` with S3 or Vercel Blob calls. Files are content-addressed and encrypted, so any store works.

The camera needs HTTPS (or `localhost`).
