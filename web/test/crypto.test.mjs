import * as c from '../src/crypto.js';
import assert from 'node:assert/strict';
const anonSig = crypto.getRandomValues(new Uint8Array(64));
const reqSig = crypto.getRandomValues(new Uint8Array(64));
const K = c.photoKeyFromSignature(anonSig);
assert.deepEqual(K, c.photoKeyFromSignature(anonSig), 'photo key deterministic');
const photo = crypto.getRandomValues(new Uint8Array(50000));
const blob = await c.encryptPhoto(K, photo);
const reqSecret = c.requesterSecretFromSignature(reqSig);
const reqPub = c.publicKeyOf(reqSecret);
assert.equal(reqPub.length, 65); assert.equal(reqPub[0], 4);
const wrapped = await c.wrapKey(K, reqPub);
assert.equal(wrapped.length, 125);
// requester re-derives secret from a fresh signature (same bytes) and opens it
const K2 = await c.unwrapKey(wrapped, c.requesterSecretFromSignature(reqSig));
assert.deepEqual(K2, K);
assert.deepEqual(await c.decryptPhoto(K2, blob), photo);
// a different wallet cannot open it
const other = c.requesterSecretFromSignature(crypto.getRandomValues(new Uint8Array(64)));
await assert.rejects(c.unwrapKey(wrapped, other));
// tampered blob is rejected
const bad = blob.slice(); bad[40] ^= 1;
await assert.rejects(c.decryptPhoto(K, bad));
assert.deepEqual(c.signatureBytes(btoa(String.fromCharCode(...anonSig))), anonSig);
console.log('crypto: all checks passed');
