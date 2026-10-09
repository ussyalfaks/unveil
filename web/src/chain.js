import { Buffer } from 'buffer';
import { contract } from '@stellar/stellar-sdk';
import * as freighter from '@stellar/freighter-api';
import { CONFIG } from './config.js';
import { signatureBytes } from './crypto.js';

let address = null;
const clients = new Map();

function check(res) {
  if (res && res.error) throw new Error(res.error.message || String(res.error));
  return res;
}

export async function connect() {
  const conn = await freighter.isConnected();
  if (!conn || !conn.isConnected) throw new Error('Freighter wallet not found. Install it from freighter.app and switch it to Testnet.');
  const { address: a } = check(await freighter.requestAccess());
  address = a;
  remember(true);
  return a;
}

// Freighter can't revoke a site's access, so "disconnect" is ours: forget the
// wallet and don't silently reconnect on the next load.
const FLAG = 'unveil:disconnected';
function remember(on) {
  try {
    on ? localStorage.removeItem(FLAG) : localStorage.setItem(FLAG, '1');
  } catch {}
}
function disconnectedByUser() {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

export function disconnect() {
  address = null;
  watcher?.stop();
  watcher = null;
  clients.clear();
  remember(false);
}

/** Reconnect without a prompt if Freighter already allowed this site. */
export async function restore() {
  try {
    if (disconnectedByUser() || !(await freighter.isAllowed())?.isAllowed) return null;
    const { address: a } = await freighter.getAddress();
    address = a || null;
    return address;
  } catch {
    return null;
  }
}

/** Call `cb(address)` whenever the user switches account in Freighter. */
let watcher = null;
export function onAccountChange(cb) {
  if (watcher) return;
  watcher = new freighter.WatchWalletChanges(1500);
  watcher.watch(({ address: a }) => {
    if (a && a !== address) {
      address = a;
      cb(a);
    }
  });
}

export const me = () => address;

async function client(withSigner) {
  if (!CONFIG.CONTRACT_ID) throw new Error('No contract configured. Set VITE_CONTRACT_ID (see README).');
  const key = withSigner ? address : '';
  if (!clients.has(key)) {
    clients.set(
      key,
      contract.Client.from({
        contractId: CONFIG.CONTRACT_ID,
        networkPassphrase: CONFIG.NETWORK_PASSPHRASE,
        rpcUrl: CONFIG.RPC_URL,
        publicKey: withSigner ? address : undefined,
        signTransaction: async (xdr) =>
          check(await freighter.signTransaction(xdr, { networkPassphrase: CONFIG.NETWORK_PASSPHRASE, address })),
      }),
    );
  }
  return clients.get(key);
}

async function read(method, args = {}) {
  const c = await client(false);
  const tx = await c[method](args);
  return tx.result;
}

async function write(method, args) {
  if (!address) throw new Error('Connect your wallet first');
  const c = await client(true);
  const tx = await c[method](args);
  const sent = await tx.signAndSend();
  return { result: sent.result, hash: sent.sendTransactionResponse?.hash };
}

export async function signMessage(message) {
  const res = check(await freighter.signMessage(message, { networkPassphrase: CONFIG.NETWORK_PASSPHRASE, address }));
  return signatureBytes(res.signedMessage);
}

const buf = (u8) => Buffer.from(u8);
const tag = (s) => (s && s.tag) || s;

function normRequest(r) {
  return {
    ...r,
    id: Number(r.id),
    status: tag(r.status),
    deposit: BigInt(r.deposit),
    created_at: Number(r.created_at),
    revealed_at: Number(r.revealed_at),
    nda_hash: new Uint8Array(r.nda_hash),
    requester_key: new Uint8Array(r.requester_key),
    wrapped_key: new Uint8Array(r.wrapped_key),
    evidence_hash: new Uint8Array(r.evidence_hash),
  };
}

export const api = {
  config: async () => {
    const c = await read('config');
    return { ...c, min_deposit: BigInt(c.min_deposit), watch_secs: Number(c.watch_secs), arbiter_key: new Uint8Array(c.arbiter_key) };
  },
  getProfile: async (anon) => {
    const p = await read('get_profile', { anon });
    return p
      ? { photo_hash: new Uint8Array(p.photo_hash), captured_at: Number(p.captured_at), registered_at: Number(p.registered_at) }
      : null;
  },
  count: async () => Number(await read('request_count')),
  getRequest: async (id) => normRequest(await read('get_request', { id: BigInt(id) })),
  async allRequests() {
    const n = await this.count();
    const ids = [...Array(n).keys()].reverse();
    return Promise.all(ids.map((i) => this.getRequest(i)));
  },

  setProfile: (photoHash, capturedAt) =>
    write('set_profile', { anon: address, photo_hash: buf(photoHash), captured_at: BigInt(capturedAt) }),
  requestReveal: (anon, ndaHash, requesterKey, deposit) =>
    write('request_reveal', {
      requester: address,
      anon,
      nda_hash: buf(ndaHash),
      requester_key: buf(requesterKey),
      deposit: BigInt(deposit),
    }),
  approve: (id, wrapped) => write('approve', { anon: address, id: BigInt(id), wrapped_key: buf(wrapped) }),
  decline: (id) => write('decline', { anon: address, id: BigInt(id) }),
  cancel: (id) => write('cancel', { requester: address, id: BigInt(id) }),
  release: (id) => write('release', { requester: address, id: BigInt(id) }),
  reportLeak: (id, evidenceHash) =>
    write('report_leak', { anon: address, id: BigInt(id), evidence_hash: buf(evidenceHash) }),
  resolve: (id, leaked) => write('resolve', { id: BigInt(id), leaked }),
  setArbiterKey: (key) => write('set_arbiter_key', { key: buf(key) }),
};

// ---- encrypted storage for photos and evidence (ciphertext only, content-addressed) ----
export async function uploadBlob(bytes) {
  const r = await fetch('/api/blob', { method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' } });
  if (!r.ok) throw new Error('Upload failed: ' + (await r.text()));
  return (await r.json()).hash;
}

export async function downloadBlob(hex) {
  const r = await fetch('/api/blob/' + hex);
  if (!r.ok) throw new Error('Encrypted file not found on the server');
  return new Uint8Array(await r.arrayBuffer());
}
