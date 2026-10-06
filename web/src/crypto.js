// All encryption happens in the browser. The server and the chain only ever
// see ciphertext, hashes and public keys.
//
//  photo key K  : AES-256-GCM key, derived from the anon's wallet signature,
//                 so it can be recovered any time by signing again.
//  requester key: P-256 key pair, derived the same way from the requester's
//                 wallet signature. The public half goes on-chain.
//  wrapped key  : K encrypted to the requester's public key with ECDH +
//                 HKDF + AES-GCM. Only that requester can open it.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const SALT = enc.encode('unveil/v1');

export const PHOTO_KEY_MESSAGE = (addr) =>
  `Unveil photo key v1\n${addr}\nSigning this derives the key that encrypts your photo. It does not move funds.`;
export const REQUESTER_KEY_MESSAGE = (addr) =>
  `Unveil requester key v1\n${addr}\nSigning this derives the key that lets you open approved reveals. It does not move funds.`;

export function sha256Bytes(bytes) {
  return sha256(bytes);
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Photo key from the anon's (deterministic ed25519) wallet signature. */
export function photoKeyFromSignature(sig) {
  return hkdf(sha256, sig, SALT, enc.encode('photo-key'), 32);
}

/** Requester's P-256 secret from their wallet signature. */
export function requesterSecretFromSignature(sig) {
  for (let i = 0; i < 256; i++) {
    const cand = hkdf(sha256, sig, SALT, enc.encode(`requester-key/${i}`), 32);
    if (p256.utils.isValidSecretKey(cand)) return cand;
  }
  throw new Error('could not derive key');
}

export function publicKeyOf(secret) {
  return p256.getPublicKey(secret, false); // 65 bytes, 0x04 || X || Y
}

async function aes(keyBytes, usage) {
  return subtle.importKey('raw', keyBytes, 'AES-GCM', false, [usage]);
}

async function seal(keyBytes, plain, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aes(keyBytes, 'encrypt'), plain),
  );
  return concat(iv, ct);
}

async function open(keyBytes, sealed, aad) {
  const iv = sealed.slice(0, 12);
  const ct = sealed.slice(12);
  return new Uint8Array(
    await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aes(keyBytes, 'decrypt'), ct),
  );
}

export function encryptPhoto(photoKey, jpegBytes) {
  return seal(photoKey, jpegBytes, enc.encode('unveil/photo'));
}

export function decryptPhoto(photoKey, blob) {
  return open(photoKey, blob, enc.encode('unveil/photo'));
}

function kek(sharedCompressed, ephPub, reqPub) {
  const x = sharedCompressed.slice(1); // drop the 0x02/0x03 prefix
  return hkdf(sha256, x, SALT, concat(enc.encode('wrap'), ephPub, reqPub), 32);
}

/** Encrypt the photo key so only `requesterPub` can open it. Returns 125 bytes. */
export async function wrapKey(photoKey, requesterPub) {
  const eph = p256.utils.randomSecretKey();
  const ephPub = p256.getPublicKey(eph, false);
  const k = kek(p256.getSharedSecret(eph, requesterPub), ephPub, requesterPub);
  return concat(ephPub, await seal(k, photoKey, enc.encode('unveil/wrap')));
}

export async function unwrapKey(wrapped, requesterSecret) {
  const ephPub = wrapped.slice(0, 65);
  const reqPub = publicKeyOf(requesterSecret);
  const k = kek(p256.getSharedSecret(requesterSecret, ephPub), ephPub, reqPub);
  return open(k, wrapped.slice(65), enc.encode('unveil/wrap'));
}

/** Freighter returns the signature as base64 (v4) or a Buffer (v3). */
export function signatureBytes(signed) {
  if (signed instanceof Uint8Array) return new Uint8Array(signed);
  if (typeof signed === 'string') return Uint8Array.from(atob(signed), (c) => c.charCodeAt(0));
  if (signed && signed.data) return Uint8Array.from(signed.data);
  throw new Error('Wallet returned no signature');
}
