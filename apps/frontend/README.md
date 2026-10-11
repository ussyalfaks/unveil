# Unveil (Next.js)

The Unveil app rebuilt with Next.js and TypeScript on top of [`unveil-sdk`](../../packages/sdk). Same screens and flow as the original `web/` app. All encryption and contract logic lives in the SDK; this app is only UI plus a small storage API.

## Run it

From the repo root:

```bash
npm install
cp apps/frontend/.env.example apps/frontend/.env.local   # then set NEXT_PUBLIC_CONTRACT_ID
npm run dev                                       # http://localhost:3000
```

`npm run dev` builds the SDK first, then starts Next.js. For a production build: `npm run build -w @unveil/frontend && npm run start -w @unveil/frontend`.

| Variable | |
|---|---|
| `NEXT_PUBLIC_CONTRACT_ID` | The deployed contract (`scripts/deploy.sh` prints it). |
| `NEXT_PUBLIC_TOKEN_SYMBOL` | `XLM` or `USDC`, for display. |
| `NEXT_PUBLIC_NETWORK` | `testnet` (default) or `mainnet`. |
| `DATA_DIR` | Where the storage API writes encrypted files locally (default `apps/frontend/data`). |
| `BLOB_STORE_ID` / `BLOB_READ_WRITE_TOKEN` | Set by Vercel when a Blob store is connected; either switches storage to Vercel Blob. |

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
  blob-store.ts              storage used by the API routes (Vercel Blob or disk)
```

## Deploying

### Vercel

1. **Add New → Project**, import the repo.
2. **Root Directory:** `apps/frontend`. Leave the build and install commands as they are, and keep "Include files outside the root directory" on (the app builds `packages/sdk` from the workspace).
3. **Environment variables:** `NEXT_PUBLIC_CONTRACT_ID`, `NEXT_PUBLIC_TOKEN_SYMBOL`, `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_PLATFORM_ID` (copy them from `.env.local`).
4. **Storage → Create Database → Blob → Continue**, set access to **Private**, and create it inside the project. Vercel connects it and sets `BLOB_STORE_ID` (and `BLOB_READ_WRITE_TOKEN`); the storage API then switches from the disk to Vercel Blob automatically. Redeploy afterwards.
5. Deploy. Pushes to `main` redeploy.

Vercel has no persistent disk, so step 4 is required: without it, uploaded photos disappear.

### Other hosts

On a host with a persistent volume (Render, Railway, Fly.io), no Blob store is needed: set `DATA_DIR` to the volume. `lib/blob-store.ts` is the only file to change for S3 or IPFS; files are content-addressed and encrypted, so any store works.

The camera needs HTTPS (or `localhost`).
