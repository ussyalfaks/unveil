import { CodeBlock } from './CodeBlock';

export const DEVELOPER_SECTIONS = [
  { id: 'install', title: 'Install' },
  { id: 'setup', title: 'Set up the client' },
  { id: 'register', title: 'Anon: register a photo' },
  { id: 'request', title: 'Requester: sign the NDA' },
  { id: 'approve', title: 'Anon: approve or decline' },
  { id: 'open', title: 'Requester: view the reveal' },
  { id: 'watch', title: 'Watch window & leaks' },
  { id: 'arbiter', title: 'Arbiter' },
  { id: 'reads', title: 'Reading state' },
  { id: 'progress', title: 'Progress & errors' },
  { id: 'wallets', title: 'Custom wallets' },
];

export function DevelopersDocs({ contractId }: { contractId: string }) {
  return (
    <>
      <section id="install">
        <h2>Install</h2>
        <p>
          <code>unveil-sdk</code> is a TypeScript SDK with full type definitions. The wallet picker is optional and lives on its own import
          path, so apps that bring their own wallet never load it.
        </p>
        <CodeBlock
          lang="bash"
          code={`
npm install unveil-sdk
# optional: ready-made wallet picker (Freighter, xBull, LOBSTR, Hana)
npm install @creit.tech/stellar-wallets-kit @stellar/freighter-api`}
        />
        <table className="doc-table">
          <thead>
            <tr>
              <th>Import</th>
              <th>Runs in</th>
              <th>What&apos;s in it</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>unveil-sdk</code></td>
              <td>browser, Node</td>
              <td>The <code>Unveil</code> client, storage, NDA builder, amounts, encryption</td>
            </tr>
            <tr>
              <td><code>unveil-sdk/browser</code></td>
              <td>browser</td>
              <td>Camera capture and the watermarked peephole viewer</td>
            </tr>
            <tr>
              <td><code>unveil-sdk/wallets-kit</code></td>
              <td>browser</td>
              <td>Wallet picker limited to wallets that can sign messages</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section id="setup">
        <h2>Set up the client</h2>
        <p>
          One <code>Unveil</code> instance per app. It needs a wallet, a place to store encrypted files, and the contract ID. Every action
          below goes through it.
        </p>
        <CodeBlock
          title="lib/unveil.ts"
          code={`
import { Unveil, httpStorage, TESTNET } from 'unveil-sdk';
import { createWalletsKit } from 'unveil-sdk/wallets-kit';

const kit = createWalletsKit({ network: TESTNET });

export const unveil = new Unveil({
  contractId: '${contractId || 'C…'}',
  network: TESTNET,                    // or MAINNET
  wallet: kit.adapter,
  storage: httpStorage('/api/blob'),   // see Platform Integration → Storage
});

// Opens the wallet picker; resolves to the user's address.
const address = await kit.connect();`}
        />
        <p className="muted">
          In React or Next.js, create the kit inside <code>useEffect</code> or a dynamic import. It touches <code>window</code> and must not run
          during server rendering.
        </p>
      </section>

      <section id="register">
        <h2>Anon: register a photo</h2>
        <p>
          The anon takes a live selfie. <code>capturePhoto</code> burns their wallet and the time into the pixels. <code>register</code>{' '}
          encrypts the photo (and the optional real name) with a key derived from a wallet signature, uploads only ciphertext, and puts its
          hash on-chain.
        </p>
        <CodeBlock
          title="anon/register.ts"
          code={`
import { startCamera, stopCamera, capturePhoto } from 'unveil-sdk/browser';

const stream = await startCamera();
video.srcObject = stream;

// when the user clicks "take photo"
const { bytes, capturedAt } = await capturePhoto(video, address);
stopCamera(stream);

await unveil.anon.register({
  photo: bytes,
  capturedAt,
  realName: 'Ada Lovelace',   // optional, max 80 characters; revealed with the photo
});`}
        />
        <p className="muted">Photos older than 10 minutes are rejected (<code>maxPhotoAgeSecs</code> changes this).</p>
      </section>

      <section id="request">
        <h2>Requester: sign the NDA</h2>
        <p>
          The requester agrees to an NDA and locks a deposit in one transaction. The NDA&apos;s SHA-256 goes on-chain with their signature, so
          their Stellar signature is their signature on the agreement. The full text is stored so the anon can read exactly what was signed.
        </p>
        <CodeBlock
          title="requester/request.ts"
          code={`
import { buildNda, toUnits } from 'unveil-sdk';

const cfg = await unveil.config();   // min deposit, watch window, arbiter key

const ndaText = buildNda({
  recipient: 'Grace Hopper',          // also stamped on every view
  organisation: 'Example DAO',
  recipientWallet: address,
  discloserWallet: anonAddress,
  purpose: 'Vetting before treasury signer role',
  deposit: '50',
  tokenSymbol: 'XLM',
  watchSecs: cfg.watchSecs,
});

const { result: requestId } = await unveil.requester.request({
  anon: anonAddress,
  ndaText,
  deposit: toUnits(50),               // smallest units: 50 XLM = 500000000n
});`}
        />
      </section>

      <section id="approve">
        <h2>Anon: approve or decline</h2>
        <p>
          Approving re-derives the photo key, checks it really opens the registered photo, then encrypts it to the requester&apos;s public
          key. Only that requester can decrypt. Declining refunds the deposit straight away.
        </p>
        <CodeBlock
          title="anon/inbox.ts"
          code={`
const incoming = await unveil.requests({ anon: address, status: 'Pending' });

for (const r of incoming) {
  const nda = await unveil.ndaText(r);   // show this to the anon before they decide
}

await unveil.anon.approve(requestId);
// or
await unveil.anon.decline(requestId);`}
        />
      </section>

      <section id="open">
        <h2>Requester: view the reveal</h2>
        <p>
          <code>open</code> decrypts the photo and real name in the requester&apos;s browser. Show it through the peephole: one small circle
          at a time, with the viewer&apos;s identity stamped across every visible pixel.
        </p>
        <CodeBlock
          title="requester/view.ts"
          code={`
import { ndaRecipient } from 'unveil-sdk';
import { openPeephole } from 'unveil-sdk/browser';

const { jpeg, name, ndaText } = await unveil.requester.open(requestId);

const close = await openPeephole(container, jpeg, {
  watermark: [ndaRecipient(ndaText), \`\${address} · #\${requestId}\`, new Date().toISOString()],
});

// later: close();`}
        />
        <p className="muted">
          The decrypted image lives in the viewer&apos;s memory, so a determined viewer can extract it. The watermark makes any copy
          traceable, and the deposit makes leaking expensive.
        </p>
      </section>

      <section id="watch">
        <h2>Watch window &amp; leaks</h2>
        <p>
          After a reveal the deposit stays locked for the watch window. If the anon finds a leak in that time, they upload the leaked image.
          It&apos;s sealed so only the arbiter can open it, and its hash goes on-chain. Otherwise the requester takes the deposit back.
        </p>
        <CodeBlock
          title="watch-window.ts"
          code={`
// Anon, inside the window: report with the leaked image
await unveil.anon.reportLeak(requestId, new Uint8Array(await file.arrayBuffer()));

// Requester, after the window: withdraw the deposit
const r = await unveil.request(requestId);
if (Date.now() / 1000 >= (await unveil.unlocksAt(r))) {
  await unveil.requester.release(requestId);
}

// Requester, before the anon answers: cancel and refund
await unveil.requester.cancel(requestId);`}
        />
      </section>

      <section id="arbiter">
        <h2>Arbiter</h2>
        <p>
          The arbiter is the contract admin. They publish an evidence key once per deployment, then settle disputes by checking the watermark
          on the leaked image.
        </p>
        <CodeBlock
          title="arbiter.ts"
          code={`
// once per deployment, from the admin wallet
await unveil.arbiter.setupKey();

const disputes = await unveil.requests({ status: 'Disputed' });
const image = await unveil.arbiter.openEvidence(disputes[0].id);   // Uint8Array

await unveil.arbiter.resolve(disputes[0].id, true);   // leak proven: deposit to the anon
await unveil.arbiter.resolve(disputes[0].id, false);  // not proven: refund the requester`}
        />
      </section>

      <section id="reads">
        <h2>Reading state</h2>
        <p>Reads need no wallet and no signatures.</p>
        <CodeBlock
          title="reads.ts"
          code={`
await unveil.config();                         // { admin, token, minDeposit, watchSecs, arbiterKey }
await unveil.profile(address);                 // { photoHash, capturedAt, registeredAt } | null
await unveil.request(id);                      // one request
await unveil.requests({ anon, requester, status });   // filtered, newest first
await unveil.ndaText(request);                 // the signed NDA text, or null
await unveil.unlocksAt(request);               // unix seconds when the deposit unlocks`}
        />
        <table className="doc-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>Pending</code></td><td>Waiting for the anon</td></tr>
            <tr><td><code>Declined</code> / <code>Cancelled</code></td><td>Deposit refunded</td></tr>
            <tr><td><code>Revealed</code></td><td>Photo revealed, deposit locked for the watch window</td></tr>
            <tr><td><code>Released</code></td><td>Window ended with no report, deposit refunded</td></tr>
            <tr><td><code>Disputed</code></td><td>Leak reported, waiting for the arbiter</td></tr>
            <tr><td><code>Slashed</code></td><td>Leak proven, deposit paid to the anon</td></tr>
            <tr><td><code>Cleared</code></td><td>Leak not proven, deposit refunded</td></tr>
          </tbody>
        </table>
      </section>

      <section id="progress">
        <h2>Progress &amp; errors</h2>
        <p>
          Most actions ask the user to sign something. <code>onProgress</code> fires before each step so you can tell them what&apos;s coming.
        </p>
        <CodeBlock
          title="progress.ts"
          code={`
import { Unveil, UnveilError } from 'unveil-sdk';

new Unveil({
  /* … */
  onProgress: (e) => {
    if (e.step === 'sign-message') toast(\`Sign in your wallet to derive your \${e.key} key (no funds move)\`);
    if (e.step === 'sign-transaction') toast('Confirm the transaction in your wallet');
    // e.step === 'upload' → encrypted file is being stored
  },
});

try {
  await unveil.requester.open(id);
} catch (e) {
  if (e instanceof UnveilError && e.code === 'WRONG_WALLET') {
    // ask the user to reconnect with the wallet app they used before
  }
}`}
        />
        <table className="doc-table">
          <thead>
            <tr>
              <th>UnveilError code</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>WRONG_WALLET</code></td><td>A different wallet app derived a different key than the one used before</td></tr>
            <tr><td><code>NO_ARBITER_KEY</code></td><td>Leak evidence can&apos;t be filed until the arbiter runs <code>setupKey()</code></td></tr>
            <tr><td><code>HASH_MISMATCH</code></td><td>Storage returned a file that doesn&apos;t match its on-chain hash</td></tr>
            <tr><td><code>STALE_PHOTO</code></td><td>The photo is older than <code>maxPhotoAgeSecs</code></td></tr>
            <tr><td><code>NO_PROFILE</code>, <code>NOT_ALLOWED</code>, <code>BAD_INPUT</code></td><td>What they say</td></tr>
          </tbody>
        </table>
        <p className="muted">
          Contract errors pass through unchanged, for example <code>StillLocked</code> before the watch window ends.
        </p>
      </section>

      <section id="wallets">
        <h2>Custom wallets</h2>
        <p>
          Any signer works if it implements <code>WalletAdapter</code>. It must sign plain messages, and sign them the same way every time:
          Unveil derives its encryption keys from those signatures.
        </p>
        <CodeBlock
          title="wallet.ts"
          code={`
import type { WalletAdapter } from 'unveil-sdk';

const wallet: WalletAdapter = {
  getAddress: async () => address,
  signTransaction: async (xdr, { networkPassphrase, address }) => signedXdr,
  signMessage: async (message, { networkPassphrase, address }) => signatureBytes,  // Uint8Array
};`}
        />
      </section>
    </>
  );
}
