# Unveil

**Show your face to one party. Make leaking it cost them.**

Pseudonymous builders reveal who they are to one DAO, investor or employer, and nobody else. The requester signs an NDA and locks a deposit on Stellar. Every peek is watermarked with their name and wallet. Leak it, lose the deposit.

Built for **Find Your Way** (Stellar), General Track: identity.

## The problem

Web3 runs on pseudonymous contributors, and that breaks the moment money is involved. In 2022 Wonderland DAO's anonymous treasury manager turned out to be a co-founder of a collapsed exchange. Nobody had a safe way to check him first.

Today an anon has two bad options: stay anonymous and never be trusted, or send a passport scan that the platform, the team, and any future hacker can see and forward forever.

## How Unveil works

| Step | Who | What happens | Where |
|---|---|---|---|
| 1 | Anon | Takes a **live** photo. Their wallet and the time are burned into the pixels. Optionally adds their **real name**, which is packed with the photo. Both are encrypted in the browser with a key derived from their wallet signature. | Browser |
| 2 | Anon | Registers the **hash** of the encrypted photo and the capture time. | Stellar |
| 3 | Requester | Writes and signs an NDA. Its SHA-256 goes into the same transaction that **locks the deposit**. Their Stellar signature is their signature on the NDA. | Stellar |
| 4 | Anon | Reads the exact NDA, then approves: the photo key is encrypted to the requester's public key (ECDH P-256) and posted. Or declines, and the deposit is refunded. | Stellar |
| 5 | Requester | Decrypts and views the photo through a **peephole**: one small circle at a time, every visible pixel stamped with their name, wallet and reveal number. The anon's real name, if shared, is shown above it. | Browser |
| 6 | Both | **Watch window** (e.g. 7 days). No leak reported → requester withdraws. Anon reports a leak by uploading the leaked image, **encrypted so only the arbiter can open it**; its hash goes on-chain → arbiter checks the watermark → deposit paid to the anon. | Stellar |

What each party can see:

- **Stellar:** wallets, NDA hash, photo hash, evidence hash, deposit, timestamps, the photo key encrypted to one requester, and the arbiter's public key. No names, no photos.
- **Storage server:** encrypted photo blobs, encrypted leak evidence and NDA texts, each stored under its SHA-256. It can't read the photos, names or evidence, and it can't swap a file without the on-chain hash exposing it. The arbiter's key lives on-chain, so the server can't swap that either.
- **Arbiter:** only the leak evidence for open disputes.
- **Requester:** the photo, through the peephole, with their own identity all over it, plus the real name if the anon shared one.

## Why Stellar

- **Deposits in USDC or XLM** via the token contract. A real cost for leaking, settled in seconds for fractions of a cent.
- **The NDA signature is the transaction signature.** `requester.require_auth()` on a call carrying the NDA hash gives a timestamped, non-repudiable signature for free.
- **An audit trail anyone can check**, with no personal data in it: every request, approval, dispute and payout is a contract event.

## Repo layout

```
contracts/unveil/   Soroban contract (Rust) + tests
packages/sdk/       unveil-sdk: TypeScript SDK (encryption, contract client, wallets, peephole)
apps/next/          Next.js + TypeScript app built on the SDK
web/                original Vite app (plain JS)
scripts/deploy.sh   build + deploy to testnet, writes web/.env and apps/next/.env.local
```

## Run it

You need Rust 1.91+, Node 20+, the [Stellar CLI](https://developers.stellar.org/docs/tools/cli/install-cli) 25.2+, and a Stellar wallet set to **Testnet**: [Freighter](https://freighter.app), [xBull](https://xbull.app), [LOBSTR](https://lobstr.co) or [Hana](https://hanawallet.io). Wallets connect through [Stellar Wallets Kit](https://stellarwalletskit.dev); only wallets that can sign plain messages are offered, because the app derives its encryption keys from those signatures.

```bash
rustup target add wasm32v1-none

# 1. Test the contract
cargo test

# 2. Deploy to testnet (creates + funds an arbiter key, writes web/.env)
./scripts/deploy.sh              # XLM deposits, 50 XLM min, 5-minute watch window (demo-friendly)
# TOKEN=usdc WATCH_SECS=604800 ./scripts/deploy.sh   # USDC deposits, 7-day window

# 3a. Run the Next.js app (uses the SDK)
npm install
npm test                         # SDK tests
npm run dev                      # http://localhost:3000

# 3b. Or run the original app
cd web
npm install
npm run test:crypto              # encryption round-trip checks
npm start                        # builds, then serves on http://localhost:8787
```

For development with hot reload, run `npm run server` and `npm run dev` in two terminals.

The camera needs `localhost` or HTTPS. To deploy publicly, host `web/` on any Node host (Render, Railway, Fly.io): build command `npm run build`, start command `npm run server`. Set the `VITE_*` variables from `web/.env` in the host's settings, and give it a persistent disk for `web/data/`.

## Demo script (about 3 minutes)

You need two wallet accounts (Anon and Requester), both funded from friendbot. Keep using the same wallet app for each account: keys are derived from signatures, and a different wallet app may sign differently. The app stops with a clear error if that happens.

0. **Arbiter (once per deploy):** import the arbiter key into your wallet (`stellar keys show unveil-admin`), connect, open the *Arbiter* tab, *Set up arbiter key*.
1. **Anon:** connect, start the camera, take a photo, optionally type a real name, *Encrypt & register*. Show the profile: photo hash, "registered 9s after capture". Copy the address.
2. **Requester:** paste the address, *Look up*: "live photo on file, taken 1 min ago". Fill in the NDA, watch the hash change as you type, tick the box, *Sign NDA & lock deposit*.
3. **Anon:** the request appears with the requester's name and the full NDA text. *Approve & reveal.*
4. **Requester:** *View identity*. The anon's real name sits above the frame. Move over the frame: one circle at a time, with their own name and wallet stamped across it.
5. **Audit trail tab:** the whole history, with no personal data in it.
6. Either wait out the 5-minute window and *Withdraw deposit*, or have the anon *Report a leak* with a screenshot of the peephole. From the arbiter account, *View evidence* to read the watermark, then resolve it.

## Contract API

| Function | Who | Effect |
|---|---|---|
| `set_profile(anon, photo_hash, captured_at)` | anon | Register or replace the encrypted-photo commitment. Rejects capture times in the future. |
| `request_reveal(requester, anon, nda_hash, requester_key, deposit) → id` | requester | Locks the deposit and records the NDA hash and the requester's P-256 public key. |
| `cancel(requester, id)` | requester | Withdraw an unanswered request; refund. |
| `approve(anon, id, wrapped_key)` | anon | Post the photo key encrypted to the requester. Starts the watch window. |
| `decline(anon, id)` | anon | Refund. |
| `report_leak(anon, id, evidence_hash)` | anon | Inside the window only; freezes the deposit. |
| `release(requester, id)` | requester | After the window; refund. |
| `set_arbiter_key(key)` | arbiter | Publish the P-256 public key that leak evidence is encrypted to. |
| `resolve(id, leaked)` | arbiter | Pay the anon (leak proven) or refund the requester. |
| `get_profile`, `get_request`, `request_count`, `config` | anyone | Reads. |

Statuses: `Pending → Revealed → Released` · `Pending → Declined | Cancelled` · `Revealed → Disputed → Slashed | Cleared`.

## Honest limits

- **The peephole raises the effort; it doesn't make copying impossible.** Once decrypted, the photo is in the requester's browser memory, and someone with developer tools can extract it. The deterrent is that any copy carries their watermark, and the deposit makes leaking expensive.
- **The real name can't be watermarked.** It's shown as text, so a requester can copy it without a trace. The deposit is the only deterrent.
- **Disputes have one arbiter** (the deployer). Next step: a multisig or a jury of staked arbiters.
- **Freshness relies on the anon's clock plus ledger time.** The contract rejects future timestamps, and the app shows how long after capture the photo reached the chain. A stronger version would bind the photo to a recent ledger hash shown on screen at capture.
- **Liveness is "a camera took this now", not face matching.** Pairing it with a passport-based ZK proof (for example with Stellar's BN254 and Poseidon primitives from Protocol 25) would prove the face belongs to a real document holder.
