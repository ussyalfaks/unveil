import { describe, expect, it } from 'vitest';
import * as c from '../src/crypto.js';

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe('photo encryption and key wrapping', () => {
  const anonSig = rand(64);
  const reqSig = rand(64);
  const photo = rand(50_000);

  it('derives the photo key deterministically', () => {
    expect(c.photoKeyFromSignature(anonSig)).toEqual(c.photoKeyFromSignature(anonSig));
  });

  it('lets only the requester open a wrapped key', async () => {
    const K = c.photoKeyFromSignature(anonSig);
    const blob = await c.encryptPhoto(K, photo);
    const reqPub = c.publicKeyOf(c.requesterSecretFromSignature(reqSig));
    expect(reqPub.length).toBe(65);
    expect(reqPub[0]).toBe(4);

    const wrapped = await c.wrapKey(K, reqPub);
    expect(wrapped.length).toBe(125);
    const K2 = await c.unwrapKey(wrapped, c.requesterSecretFromSignature(reqSig));
    expect(K2).toEqual(K);
    expect(await c.decryptPhoto(K2, blob)).toEqual(photo);

    const other = c.requesterSecretFromSignature(rand(64));
    await expect(c.unwrapKey(wrapped, other)).rejects.toThrow();
  });

  it('rejects a tampered blob', async () => {
    const K = c.photoKeyFromSignature(anonSig);
    const bad = (await c.encryptPhoto(K, photo)).slice();
    bad[40] ^= 1;
    await expect(c.decryptPhoto(K, bad)).rejects.toThrow();
  });
});

describe('profile bundle', () => {
  const photo = rand(1000);

  it('round-trips the name with the photo', () => {
    expect(c.unpackProfile(c.packProfile('  Ada Lovelace  ', photo))).toEqual({ name: 'Ada Lovelace', jpeg: photo });
    expect(c.unpackProfile(c.packProfile('', photo))).toEqual({ name: '', jpeg: photo });
    expect(c.unpackProfile(c.packProfile('Zoë 李', photo)).name).toBe('Zoë 李');
  });

  it('enforces limits and format', () => {
    expect(() => c.packProfile('x'.repeat(81), photo)).toThrow(/80/);
    expect(() => c.unpackProfile(photo)).toThrow(/format/);
  });
});

describe('arbiter evidence', () => {
  it('derives a different key from the same signature than the requester', () => {
    const sig = rand(64);
    expect(c.arbiterSecretFromSignature(sig)).not.toEqual(c.requesterSecretFromSignature(sig));
    expect(c.arbiterSecretFromSignature(sig)).toEqual(c.arbiterSecretFromSignature(sig));
  });

  it('lets only the arbiter open evidence', async () => {
    const arb = c.arbiterSecretFromSignature(rand(64));
    const leak = rand(30_000);
    const sealed = await c.sealEvidence(c.publicKeyOf(arb), leak);
    expect(await c.openEvidence(sealed, arb)).toEqual(leak);
    await expect(c.openEvidence(sealed, c.arbiterSecretFromSignature(rand(64)))).rejects.toThrow();
  });
});

describe('signature formats', () => {
  const sig = rand(64);
  it('accepts base64, hex and 0x-hex', () => {
    expect(c.signatureBytes(btoa(String.fromCharCode(...sig)))).toEqual(sig);
    expect(c.signatureBytes(c.toHex(sig))).toEqual(sig);
    expect(c.signatureBytes('0x' + c.toHex(sig))).toEqual(sig);
    expect(c.signatureBytes({ data: Array.from(sig) })).toEqual(sig);
  });
  it('round-trips hex', () => {
    expect(c.fromHex(c.toHex(sig))).toEqual(sig);
    expect(() => c.fromHex('zz')).toThrow();
  });
});
