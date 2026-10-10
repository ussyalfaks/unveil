// All encryption happens in the browser. The server and the chain only ever
// see ciphertext, hashes and public keys.
//
//  photo key K  : AES-256-GCM key, derived from the anon's wallet signature,
//                 so it can be recovered any time by signing again.
//  requester key: P-256 key pair, derived the same way from the requester's
//                 wallet signature. The public half goes on-chain.
//  wrapped key  : K encrypted to the requester's public key with ECDH +
//                 HKDF + AES-GCM. Only that requester can open it.
//  arbiter key  : P-256 key pair derived like the requester key. The public
//                 half is stored in the contract; leak evidence is sealed to it.
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
export const ARBITER_KEY_MESSAGE = (addr) =>
  `Unveil arbiter key v1\n${addr}\nSigning this derives the key that opens leak evidence. It does not move funds.`;

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

function p256SecretFromSignature(sig, label) {
  for (let i = 0; i < 256; i++) {
    const cand = hkdf(sha256, sig, SALT, enc.encode(`${label}/${i}`), 32);
    if (p256.utils.isValidSecretKey(cand)) return cand;
  }
  throw new Error('could not derive key');
}

/** Requester's P-256 secret from their wallet signature. */
export const requesterSecretFromSignature = (sig) => p256SecretFromSignature(sig, 'requester-key');

/** Arbiter's P-256 secret from their wallet signature. */
export const arbiterSecretFromSignature = (sig) => p256SecretFromSignature(sig, 'arbiter-key');

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

// What gets encrypted at registration: "UNV2" || name length (u16 BE) || name || JPEG.
// The on-chain hash covers the whole thing, so the name can't be swapped either.
const MAGIC = enc.encode('UNV2');
export const MAX_NAME = 80;

export function packProfile(name, jpegBytes) {
  const n = enc.encode(name.trim());
  if (name.trim().length > MAX_NAME) throw new Error(`Name is limited to ${MAX_NAME} characters`);
  return concat(MAGIC, new Uint8Array([n.length >> 8, n.length & 0xff]), n, jpegBytes);
}

export function unpackProfile(bytes) {
  if (bytes.length < 6 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('Unknown photo format');
  const len = (bytes[4] << 8) | bytes[5];
  return { name: new TextDecoder().decode(bytes.slice(6, 6 + len)), jpeg: bytes.slice(6 + len) };
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

/** Wallets return the signature as base64, hex, or raw bytes. */
export function signatureBytes(signed) {
  if (signed instanceof Uint8Array) return new Uint8Array(signed);
  if (typeof signed === 'string') {
    const hex = signed.replace(/^0x/, '');
    // A 64-byte ed25519 signature is 128 hex characters; base64 of it is 88.
    if (/^[0-9a-f]{128}$/i.test(hex)) return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
    return Uint8Array.from(atob(signed), (c) => c.charCodeAt(0));
  }
  if (signed && signed.data) return Uint8Array.from(signed.data);
  throw new Error('Wallet returned no signature');
}

/** Seal leak evidence so only the arbiter can open it: wrapped key (125 bytes) || ciphertext. */
export async function sealEvidence(arbiterPub, bytes) {
  const k = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return concat(await wrapKey(k, arbiterPub), await seal(k, bytes, enc.encode('unveil/evidence')));
}

export async function openEvidence(sealed, arbiterSecret) {
  const k = await unwrapKey(sealed.slice(0, 125), arbiterSecret);
  return open(k, sealed.slice(125), enc.encode('unveil/evidence'));
}
