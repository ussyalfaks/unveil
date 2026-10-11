# unveil-sdk

Add controlled identity reveal to any Stellar app. A pseudonymous user shows their live photo (and optionally their real name) to one party. That party signs an NDA and locks a deposit on-chain. Every view is watermarked with the viewer's identity, and a proven leak pays the deposit to the person who was exposed.

Everything is encrypted on the client. Storage only ever holds ciphertext, and the chain holds hashes and public keys.

## Install

```bash
npm install unveil-sdk
# for the ready-made wallet picker (Freighter, xBull, LOBSTR, Hana):
npm install @creit.tech/stellar-wallets-kit @stellar/freighter-api
```

## Quick start

```ts
import { Unveil, httpStorage, buildNda, toUnits, TESTNET } from 'unveil-sdk';
import { createWalletsKit } from 'unveil-sdk/wallets-kit';
import { startCamera, capturePhoto, openPeephole } from 'unveil-sdk/browser';

const kit = createWalletsKit({ network: TESTNET });
const unveil = new Unveil({
  contractId: 'C…',
  network: TESTNET,
  platform: 0,                       // the platform requests go through
  wallet: kit.adapter,
  storage: httpStorage('/api/blob'),
  onProgress: (e) => console.log(e), // e.g. show "sign in your wallet"
});

const me = await kit.connect();

// Anon: take a live photo and register it
const stream = await startCamera();
video.srcObject = stream;
const { bytes, capturedAt } = await capturePhoto(video, me);
await unveil.anon.register({ photo: bytes, capturedAt, realName: 'Ada Lovelace' });

// Requester: check the fee, then sign the NDA and lock deposit + fee
const cfg = await unveil.config();
const { fee } = await unveil.quote();   // charged only if the anon approves
const ndaText = buildNda({
  recipient: 'Grace', recipientWallet: me, discloserWallet: anonAddress,
  deposit: '50', tokenSymbol: 'XLM', watchSecs: cfg.watchSecs,
});
const { result: id } = await unveil.requester.request({ anon: anonAddress, ndaText, deposit: toUnits(50) });

// Anon: approve
await unveil.anon.approve(id);

// Requester: view through the watermarked peephole
const { jpeg, name } = await unveil.requester.open(id);
const close = await openPeephole(container, jpeg, { watermark: ['Grace', `${me} · #${id}`] });
```

## API

### `new Unveil(options)`

| Option | |
|---|---|
| `wallet` | A `WalletAdapter`. Use `createWalletsKit().adapter`, or write your own. |
| `storage` | A `BlobStorage`. `httpStorage(url)` talks to the reference API; `memoryStorage()` is for tests. |
| `contractId` | The deployed Unveil contract. |
| `network` | `TESTNET` (default), `MAINNET`, or `{ rpcUrl, networkPassphrase }`. |
| `onProgress` | Called before each step that needs the user: `sign-message`, `upload`, `sign-transaction`. |
| `maxPhotoAgeSecs` | Reject older photos at registration. Default 600. |
| `platform` | Platform id that requests go through. Default `0`. |
| `contract` | Swap in your own `ContractApi` (tests, custom transports). |

### Reads
`config()`, `profile(address)`, `request(id)`, `requests({ anon?, requester?, status? })`, `ndaText(request)`, `unlocksAt(request)`, `quote(platform?)` → `{ fee, protocolCut, platformCut, platform }`.

### Platforms
Anyone can register a platform with its own fee, payout address and arbiter. The fee is locked with the deposit and paid out only if the anon approves (a protocol cut goes to the treasury); decline or cancel refunds it.

`platforms.register({ name, feeTo, arbiter, fee })` → id, `platforms.update(id, { feeTo?, arbiter?, fee? })` (owner only), `platforms.get(id)`, `platforms.list()`.

Each request records the fee and arbiter in force when it was made, so later changes to the platform don't affect it.

### Anon
`anon.register({ photo, capturedAt, realName? })`, `anon.approve(id)`, `anon.decline(id)`, `anon.reportLeak(id, imageBytes)`.

### Requester
`requester.request({ anon, ndaText, deposit, platform?, maxFee? })` (`maxFee` defaults to the platform's current fee and protects against a fee rise), `requester.cancel(id)`, `requester.release(id)`, `requester.open(id)` → `{ jpeg, name, request, ndaText }`.

### Arbiter (per platform)
`arbiter.setupKey(platform?)` (once per platform, by its arbiter), `arbiter.openEvidence(id)`, `arbiter.resolve(id, leaked)` (by the arbiter recorded on the request).

### Errors
Failures from the SDK's own checks are `UnveilError` with a `code`:

| Code | Meaning |
|---|---|
| `WRONG_WALLET` | The wallet derived a different key than the one used before. Users must keep using the same wallet app per account. |
| `NO_ARBITER_KEY` | Leak evidence can't be filed until the request's arbiter runs `arbiter.setupKey()` (or the platform has since replaced that arbiter). |
| `HASH_MISMATCH` | Storage returned a file that doesn't match its on-chain hash. |
| `STALE_PHOTO` | The photo is older than `maxPhotoAgeSecs`. |
| `NO_PROFILE`, `NOT_ALLOWED`, `BAD_INPUT` | What they say. |

Contract errors (for example `StillLocked` before the watch window ends) come through from the chain unchanged.

## Storage API

`httpStorage` expects two endpoints. Any backend works, because the client checks every file against its on-chain hash:

```
POST /api/blob          body: bytes          → { "hash": "<sha256 hex>" }
GET  /api/blob/<hex>    → bytes
```

## Wallets

Keys are derived from wallet signatures, so a wallet must sign plain messages, and sign them the same way every time. `createWalletsKit` offers only wallets that do: Freighter, xBull, LOBSTR and Hana. Albedo, Rabet, Ledger and Trezor can't sign messages.

To use another signer, implement `WalletAdapter`:

```ts
interface WalletAdapter {
  getAddress(): Promise<string>;
  signTransaction(xdr: string, opts: { networkPassphrase: string; address: string }): Promise<string>;
  signMessage(message: string, opts: { networkPassphrase: string; address: string }): Promise<Uint8Array>;
}
```

## Protocol stability

The encryption formats (`UNV2` profile bundle, `unveil/v1` key derivation, the 125-byte wrapped key) are part of the protocol. They are versioned and won't change silently, so photos and reveals made with one SDK version open with the next.

## License

MIT
