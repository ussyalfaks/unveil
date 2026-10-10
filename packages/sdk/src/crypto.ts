// All encryption happens on the client. The server and the chain only ever
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
//
// These byte formats are part of the protocol. Changing them breaks every
// photo, reveal and piece of evidence already stored, so they are versioned.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

export type Bytes = Uint8Array;

const enc = new TextEncoder();
const SALT = enc.encode('unveil/v1');

/** Copy into a fresh ArrayBuffer-backed array (what WebCrypto's types want). */
const buf = (u: Bytes): Uint8Array<ArrayBuffer> => new Uint8Array(u);
const subtle = () => globalThis.crypto.subtle;

export const PHOTO_KEY_MESSAGE = (addr: string) =>
  `Unveil photo key v1\n${addr}\nSigning this derives the key that encrypts your photo. It does not move funds.`;
export const REQUESTER_KEY_MESSAGE = (addr: string) =>
  `Unveil requester key v1\n${addr}\nSigning this derives the key that lets you open approved reveals. It does not move funds.`;
export const ARBITER_KEY_MESSAGE = (addr: string) =>
  `Unveil arbiter key v1\n${addr}\nSigning this derives the key that opens leak evidence. It does not move funds.`;

export function sha256Bytes(bytes: Bytes): Bytes {
  return sha256(bytes);
}

export function toHex(bytes: Bytes): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Bytes {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('Invalid hex');
  return Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16));
}

export function bytesEqual(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Photo key from the anon's (deterministic ed25519) wallet signature. */
export function photoKeyFromSignature(sig: Bytes): Bytes {
  return hkdf(sha256, sig, SALT, enc.encode('photo-key'), 32);
}

function p256SecretFromSignature(sig: Bytes, label: string): Bytes {
  for (let i = 0; i < 256; i++) {
    const cand = hkdf(sha256, sig, SALT, enc.encode(`${label}/${i}`), 32);
    if (p256.utils.isValidSecretKey(cand)) return cand;
  }
  throw new Error('could not derive key');
}

/** Requester's P-256 secret from their wallet signature. */
export const requesterSecretFromSignature = (sig: Bytes) => p256SecretFromSignature(sig, 'requester-key');

/** Arbiter's P-256 secret from their wallet signature. */
export const arbiterSecretFromSignature = (sig: Bytes) => p256SecretFromSignature(sig, 'arbiter-key');

/** 65-byte uncompressed P-256 public key (0x04 || X || Y). */
export function publicKeyOf(secret: Bytes): Bytes {
  return p256.getPublicKey(secret, false);
}

async function aes(keyBytes: Bytes, usage: KeyUsage): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(keyBytes), 'AES-GCM', false, [usage]);
}

async function seal(keyBytes: Bytes, plain: Bytes, aad: Bytes): Promise<Bytes> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: buf(aad) }, await aes(keyBytes, 'encrypt'), buf(plain)),
  );
  return concat(iv, ct);
}

async function open(keyBytes: Bytes, sealed: Bytes, aad: Bytes): Promise<Bytes> {
  const iv = buf(sealed.slice(0, 12));
  const ct = buf(sealed.slice(12));
  return new Uint8Array(
    await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: buf(aad) }, await aes(keyBytes, 'decrypt'), ct),
  );
}

export function encryptPhoto(photoKey: Bytes, plain: Bytes): Promise<Bytes> {
  return seal(photoKey, plain, enc.encode('unveil/photo'));
}

export function decryptPhoto(photoKey: Bytes, blob: Bytes): Promise<Bytes> {
  return open(photoKey, blob, enc.encode('unveil/photo'));
}

// What gets encrypted at registration: "UNV2" || name length (u16 BE) || name || JPEG.
// The on-chain hash covers the whole thing, so the name can't be swapped either.
const MAGIC = enc.encode('UNV2');
export const MAX_NAME = 80;

export interface ProfileContent {
  /** Real name, or "" when the anon shared only their photo. */
  name: string;
  jpeg: Bytes;
}

export function packProfile(name: string, jpeg: Bytes): Bytes {
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME) throw new Error(`Name is limited to ${MAX_NAME} characters`);
  const n = enc.encode(trimmed);
  return concat(MAGIC, new Uint8Array([n.length >> 8, n.length & 0xff]), n, jpeg);
}

export function unpackProfile(bytes: Bytes): ProfileContent {
  if (bytes.length < 6 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('Unknown photo format');
  const len = (bytes[4] << 8) | bytes[5];
  return { name: new TextDecoder().decode(bytes.slice(6, 6 + len)), jpeg: bytes.slice(6 + len) };
}

function kek(sharedCompressed: Bytes, ephPub: Bytes, reqPub: Bytes): Bytes {
  const x = sharedCompressed.slice(1); // drop the 0x02/0x03 prefix
  return hkdf(sha256, x, SALT, concat(enc.encode('wrap'), ephPub, reqPub), 32);
}

/** Encrypt a 32-byte key so only `recipientPub` can open it. Returns 125 bytes. */
export async function wrapKey(key: Bytes, recipientPub: Bytes): Promise<Bytes> {
  const eph = p256.utils.randomSecretKey();
  const ephPub = p256.getPublicKey(eph, false);
  const k = kek(p256.getSharedSecret(eph, recipientPub), ephPub, recipientPub);
  return concat(ephPub, await seal(k, key, enc.encode('unveil/wrap')));
}

export async function unwrapKey(wrapped: Bytes, recipientSecret: Bytes): Promise<Bytes> {
  const ephPub = wrapped.slice(0, 65);
  const reqPub = publicKeyOf(recipientSecret);
  const k = kek(p256.getSharedSecret(recipientSecret, ephPub), ephPub, reqPub);
  return open(k, wrapped.slice(65), enc.encode('unveil/wrap'));
}

/** Wallets return the signature as base64, hex, or raw bytes. */
export function signatureBytes(signed: unknown): Bytes {
  if (signed instanceof Uint8Array) return new Uint8Array(signed);
  if (typeof signed === 'string') {
    const hex = signed.replace(/^0x/, '');
    // A 64-byte ed25519 signature is 128 hex characters; base64 of it is 88.
    if (/^[0-9a-f]{128}$/i.test(hex)) return fromHex(hex);
    return Uint8Array.from(atob(signed), (c) => c.charCodeAt(0));
  }
  const data = (signed as { data?: ArrayLike<number> } | null)?.data;
  if (data) return Uint8Array.from(data);
  throw new Error('Wallet returned no signature');
}

/** Seal leak evidence so only the arbiter can open it: wrapped key (125 bytes) || ciphertext. */
export async function sealEvidence(arbiterPub: Bytes, bytes: Bytes): Promise<Bytes> {
  const k = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return concat(await wrapKey(k, arbiterPub), await seal(k, bytes, enc.encode('unveil/evidence')));
}

export async function openEvidence(sealed: Bytes, arbiterSecret: Bytes): Promise<Bytes> {
  const k = await unwrapKey(sealed.slice(0, 125), arbiterSecret);
  return open(k, sealed.slice(125), enc.encode('unveil/evidence'));
}
