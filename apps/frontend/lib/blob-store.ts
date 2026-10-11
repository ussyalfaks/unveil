// Disk-backed, content-addressed storage for the API routes. It only ever
// receives ciphertext (photos, evidence) and NDA text, and stores each under
// the SHA-256 of its bytes. Because the hash is also on-chain, the server
// can't swap a file without clients noticing.
//
// Serverless hosts (e.g. Vercel) have no persistent disk: point DATA_DIR at a
// mounted volume, or replace these two functions with S3 / Vercel Blob calls.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_BYTES = 3 * 1024 * 1024;
// Runtime-only paths: tell the bundler not to trace them into the build output.
const DATA = process.env.DATA_DIR || join(/*turbopackIgnore: true*/ process.cwd(), 'data');

export const isHash = (s: string) => /^[0-9a-f]{64}$/.test(s);

export async function putBlob(bytes: Uint8Array): Promise<string> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  await mkdir(DATA, { recursive: true });
  await writeFile(join(/*turbopackIgnore: true*/ DATA, hash), bytes);
  return hash;
}

export async function getBlob(hash: string): Promise<Uint8Array | null> {
  if (!isHash(hash)) return null;
  try {
    return new Uint8Array(await readFile(join(/*turbopackIgnore: true*/ DATA, hash)));
  } catch {
    return null;
  }
}
