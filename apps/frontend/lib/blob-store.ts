// Content-addressed storage for the API routes. It only ever receives
// ciphertext (photos, evidence) and NDA text, and stores each under the
// SHA-256 of its bytes. Because the hash is also on-chain, the store can't
// swap a file without clients noticing.
//
// Backend is picked automatically:
//   - Vercel Blob when a Blob store is connected to the Vercel project (Vercel
//     then sets BLOB_STORE_ID and/or BLOB_READ_WRITE_TOKEN). Files are private: reachable only
//     through these API routes, never by a public URL.
//   - The local disk otherwise (DATA_DIR, default ./data), for development.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { get, put } from '@vercel/blob';

export const MAX_BYTES = 3 * 1024 * 1024;

export const isHash = (s: string) => /^[0-9a-f]{64}$/.test(s);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Backend {
  put(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | null>;
}

function vercelBlob(): Backend {
  const access = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
  const path = (hash: string) => `unveil/${hash}`;
  return {
    async put(hash, bytes) {
      await put(path(hash), Buffer.from(bytes), {
        access,
        addRandomSuffix: false,
        // Same hash means same bytes, so re-uploading is harmless.
        allowOverwrite: true,
        contentType: 'application/octet-stream',
      });
    },
    async get(hash) {
      try {
        const res = await get(path(hash), { access });
        if (!res || res.statusCode !== 200) return null;
        return new Uint8Array(await new Response(res.stream).arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}

function disk(): Backend {
  // Runtime-only paths: tell the bundler not to trace them into the build output.
  const dir = process.env.DATA_DIR || join(/*turbopackIgnore: true*/ process.cwd(), 'data');
  return {
    async put(hash, bytes) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(/*turbopackIgnore: true*/ dir, hash), bytes);
    },
    async get(hash) {
      try {
        return new Uint8Array(await readFile(join(/*turbopackIgnore: true*/ dir, hash)));
      } catch {
        return null;
      }
    },
  };
}

// Vercel sets BLOB_STORE_ID (newer stores) and/or BLOB_READ_WRITE_TOKEN when a Blob store is connected.
const onVercelBlob = !!(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
const backend: Backend = onVercelBlob ? vercelBlob() : disk();

export async function putBlob(bytes: Uint8Array): Promise<string> {
  const hash = sha256(bytes);
  await backend.put(hash, bytes);
  return hash;
}

export async function getBlob(hash: string): Promise<Uint8Array | null> {
  if (!isHash(hash)) return null;
  const bytes = await backend.get(hash);
  // Never serve bytes that don't match their name, whatever the backend did.
  return bytes && sha256(bytes) === hash ? bytes : null;
}
