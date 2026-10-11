import { CodeBlock } from './CodeBlock';

export const PLATFORM_SECTIONS = [
  { id: 'overview', title: 'How it fits your platform' },
  { id: 'contract', title: 'Contract' },
  { id: 'storage', title: 'Storage' },
  { id: 'wallet-support', title: 'Wallet support' },
  { id: 'security', title: 'Security model' },
  { id: 'contract-api', title: 'Contract reference' },
  { id: 'checklist', title: 'Launch checklist' },
];

export function PlatformDocs({ contractId, explorer }: { contractId: string; explorer: string }) {
  return (
    <>
      <section id="overview">
        <h2>How it fits your platform</h2>
        <p>
          Unveil adds a &quot;reveal who you are&quot; step to any platform where pseudonymous people meet someone who needs to know who
          they are: DAO contributor vetting, grant shortlists, job boards, OTC desks. There&apos;s no Unveil account or API key. Your
          platform talks to the Stellar contract through the SDK, and hosts a small storage endpoint.
        </p>
        <table className="doc-table">
          <thead>
            <tr>
              <th>You provide</th>
              <th>Unveil provides</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>UI for your users (or reuse ours)</td>
              <td>Encryption, key handling and all contract calls (<code>unveil-sdk</code>)</td>
            </tr>
            <tr>
              <td>A storage endpoint for encrypted files</td>
              <td>The Soroban contract: NDA record, deposits, disputes</td>
            </tr>
            <tr>
              <td>An arbiter for disputes (your deployment&apos;s admin)</td>
              <td>The watermarked peephole viewer and camera capture</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section id="contract">
        <h2>Contract</h2>
        <p>
          Use the public testnet deployment to try things out, or deploy your own to choose the deposit token, the minimum deposit, the watch
          window and the arbiter.
        </p>
        {contractId && (
          <p>
            Testnet contract:{' '}
            <a className="link mono" target="_blank" rel="noopener" href={`${explorer}/contract/${contractId}`}>
              {contractId} ↗
            </a>
          </p>
        )}
        <CodeBlock
          lang="bash"
          title="deploy your own (needs Rust and the Stellar CLI)"
          code={`
# from the Unveil repository
rustup target add wasm32v1-none

./scripts/deploy.sh                                   # XLM deposits, 50 min, 5-minute window
TOKEN=usdc MIN_DEPOSIT=100 WATCH_SECS=604800 ./scripts/deploy.sh   # USDC, 100 min, 7 days`}
        />
        <p>
          The script creates and funds an admin key (<code>unveil-admin</code>), which is your arbiter. After deploying, connect that wallet
          and call <code>unveil.arbiter.setupKey()</code> once, or leak reports can&apos;t be filed.
        </p>
      </section>

      <section id="storage">
        <h2>Storage</h2>
        <p>
          Encrypted photos, NDA texts and sealed evidence are stored off-chain, each under the SHA-256 of its bytes. The SDK checks every
          download against the hash on-chain, so storage never has to be trusted. A hacked or buggy server can lose files but can&apos;t
          swap them. <code>httpStorage(url)</code> expects two endpoints:
        </p>
        <CodeBlock
          lang="http"
          code={`
POST {url}             body: raw bytes (≤ 3 MB)
→ 200 { "hash": "<sha256 hex>" }

GET  {url}/<sha256 hex>
→ 200 raw bytes  |  404`}
        />
        <p>A complete implementation for the Next.js App Router:</p>
        <CodeBlock
          title="app/api/blob/route.ts"
          code={`
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

export async function POST(req: Request) {
  const body = new Uint8Array(await req.arrayBuffer());
  if (!body.length || body.length > 3 * 1024 * 1024) return new Response('bad size', { status: 413 });
  const hash = createHash('sha256').update(body).digest('hex');
  await mkdir('data', { recursive: true });
  await writeFile(\`data/\${hash}\`, body);
  return Response.json({ hash });
}`}
        />
        <CodeBlock
          title="app/api/blob/[hash]/route.ts"
          code={`
import { readFile } from 'node:fs/promises';

export async function GET(_: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Response('not found', { status: 404 });
  try {
    return new Response(await readFile(\`data/\${hash}\`));
  } catch {
    return new Response('not found', { status: 404 });
  }
}`}
        />
        <p className="muted">
          On serverless hosts with no persistent disk, store files in S3, Vercel Blob or IPFS instead, or implement <code>BlobStorage</code>{' '}
          (<code>put(bytes) → hash</code>, <code>get(hash) → bytes</code>) and pass it to <code>new Unveil({'{ storage }'})</code>. Always
          validate the hash format, as above, so nobody can request paths outside your storage folder.
        </p>
      </section>

      <section id="wallet-support">
        <h2>Wallet support</h2>
        <p>
          Keys are derived from wallet signatures, so a wallet has to sign plain messages, and sign them the same way every time.
        </p>
        <table className="doc-table">
          <thead>
            <tr>
              <th>Works</th>
              <th>Doesn&apos;t work</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Freighter, xBull, LOBSTR, Hana (offered by <code>createWalletsKit</code>)</td>
              <td>Albedo, Rabet, Ledger, Trezor: they can&apos;t sign messages</td>
            </tr>
          </tbody>
        </table>
        <p>
          Tell users to keep using the same wallet app for an account. A different app can sign the same message differently and derive a
          different key. The SDK detects this and throws <code>WRONG_WALLET</code> instead of failing silently.
        </p>
      </section>

      <section id="security">
        <h2>Security model</h2>
        <table className="doc-table">
          <thead>
            <tr>
              <th>Who</th>
              <th>Can see</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Stellar (public)</td>
              <td>Wallets, NDA hash, photo hash, evidence hash, deposits, timestamps, keys encrypted to one requester. No names, no photos.</td>
            </tr>
            <tr>
              <td>Your storage server</td>
              <td>Ciphertext and NDA texts only. It can&apos;t read photos, names or evidence.</td>
            </tr>
            <tr>
              <td>The approved requester</td>
              <td>The photo, through the peephole, stamped with their identity, plus the real name if shared</td>
            </tr>
            <tr>
              <td>The arbiter</td>
              <td>Leak evidence for open disputes only</td>
            </tr>
          </tbody>
        </table>
        <p>Rules for integrators:</p>
        <ul className="doc-list">
          <li>Never send decryption keys, wallet signatures or decrypted photos to your server. The SDK keeps them in the browser; keep it that way.</li>
          <li>Serve the app over HTTPS. The camera and Web Crypto require it (<code>localhost</code> is fine for development).</li>
          <li>Show users the full NDA text before they sign. <code>unveil.ndaText(request)</code> fetches exactly what was signed.</li>
          <li>Be honest in your UI: the peephole and watermark deter leaks. They can&apos;t make copying impossible.</li>
        </ul>
      </section>

      <section id="contract-api">
        <h2>Contract reference</h2>
        <p>What the SDK calls under the hood. Every write is signed by the account in the &quot;Who&quot; column.</p>
        <table className="doc-table">
          <thead>
            <tr>
              <th>Function</th>
              <th>Who</th>
              <th>Effect</th>
            </tr>
          </thead>
          <tbody>
            <tr><td><code>set_profile</code></td><td>anon</td><td>Register or replace the encrypted-photo hash</td></tr>
            <tr><td><code>request_reveal</code></td><td>requester</td><td>Lock the deposit; record the NDA hash and viewing key</td></tr>
            <tr><td><code>approve</code> / <code>decline</code></td><td>anon</td><td>Post the wrapped photo key, or refund</td></tr>
            <tr><td><code>cancel</code></td><td>requester</td><td>Withdraw an unanswered request; refund</td></tr>
            <tr><td><code>report_leak</code></td><td>anon</td><td>Inside the window only; freezes the deposit</td></tr>
            <tr><td><code>release</code></td><td>requester</td><td>After the window; refund</td></tr>
            <tr><td><code>set_arbiter_key</code></td><td>arbiter</td><td>Publish the evidence key</td></tr>
            <tr><td><code>resolve</code></td><td>arbiter</td><td>Pay the anon or refund the requester</td></tr>
            <tr><td><code>get_profile</code>, <code>get_request</code>, <code>request_count</code>, <code>config</code></td><td>anyone</td><td>Reads</td></tr>
          </tbody>
        </table>
      </section>

      <section id="checklist">
        <h2>Launch checklist</h2>
        <ul className="doc-list checklist">
          <li>Deploy your own contract with a real watch window (days, not minutes) and a deposit large enough to deter leaks.</li>
          <li>Prefer USDC deposits, so the stake doesn&apos;t swing with the XLM price.</li>
          <li>Run <code>unveil.arbiter.setupKey()</code> from the admin wallet, and keep that wallet safe: it decides disputes.</li>
          <li>Host storage on a persistent disk or object store, with backups. Lost files mean reveals can&apos;t be opened.</li>
          <li>Serve over HTTPS and set <code>network: MAINNET</code> when you go live.</li>
          <li>Pin the SDK version. Updates keep the encryption formats compatible, but read the changelog before upgrading.</li>
        </ul>
      </section>
    </>
  );
}
