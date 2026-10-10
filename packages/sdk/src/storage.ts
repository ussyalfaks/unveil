import { sha256Bytes, toHex, type Bytes } from './crypto.js';

/**
 * Where encrypted photos, NDA texts and sealed evidence live. Every file is
 * addressed by the SHA-256 of its bytes, and that hash is also on-chain, so a
 * storage backend can't swap a file without the client noticing. Any backend
 * works: your own server, S3, Vercel Blob, IPFS.
 */
export interface BlobStorage {
  /** Store bytes; resolve to their SHA-256 as lowercase hex. */
  put(bytes: Bytes): Promise<string>;
  /** Fetch bytes by SHA-256 hex. Reject if missing. */
  get(hashHex: string): Promise<Bytes>;
}

/**
 * Talks to the reference storage API:
 *   POST {baseUrl}         body = bytes  → { "hash": "<hex>" }
 *   GET  {baseUrl}/<hex>   → bytes
 */
export function httpStorage(baseUrl = '/api/blob', fetchImpl: typeof fetch = (...a) => fetch(...a)): BlobStorage {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async put(bytes) {
      const r = await fetchImpl(base, {
        method: 'POST',
        body: new Uint8Array(bytes),
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (!r.ok) throw new Error('Upload failed: ' + (await r.text()));
      return ((await r.json()) as { hash: string }).hash;
    },
    async get(hashHex) {
      const r = await fetchImpl(`${base}/${hashHex}`);
      if (!r.ok) throw new Error('File not found in storage');
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

/** In-memory storage, for tests and demos. */
export function memoryStorage(): BlobStorage & { size(): number } {
  const files = new Map<string, Bytes>();
  return {
    async put(bytes) {
      const hex = toHex(sha256Bytes(bytes));
      files.set(hex, new Uint8Array(bytes));
      return hex;
    },
    async get(hashHex) {
      const f = files.get(hashHex);
      if (!f) throw new Error('File not found in storage');
      return new Uint8Array(f);
    },
    size: () => files.size,
  };
}
