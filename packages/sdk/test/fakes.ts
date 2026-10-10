import { sha256 } from '@noble/hashes/sha2.js';
import type { ContractApi } from '../src/contract.js';
import { concat, type Bytes } from '../src/crypto.js';
import type { Config, Profile, RevealRequest, Status } from '../src/types.js';
import type { WalletAdapter } from '../src/wallet.js';

const enc = new TextEncoder();

/** Deterministic "wallet": same message → same 64 bytes. `app` simulates a different wallet app. */
export function fakeWallet(address: string, app = 'a'): WalletAdapter {
  return {
    getAddress: async () => address,
    signTransaction: async (xdr) => xdr,
    signMessage: async (message) =>
      concat(sha256(enc.encode(`${app}|${address}|${message}`)), sha256(enc.encode(`${message}|${address}|${app}`))),
  };
}

/** In-memory twin of the Soroban contract's rules (statuses, auth, watch window). */
export function fakeContract(opts: { admin: string; minDeposit: bigint; watchSecs: number; now: () => number }): ContractApi & {
  balances: Map<string, bigint>;
} {
  const cfg: Config = { admin: opts.admin, token: 'TOKEN', minDeposit: opts.minDeposit, watchSecs: opts.watchSecs, arbiterKey: new Uint8Array() };
  const profiles = new Map<string, Profile>();
  const requests: RevealRequest[] = [];
  const balances = new Map<string, bigint>();
  const pay = (to: string, amt: bigint) => balances.set(to, (balances.get(to) ?? 0n) + amt);
  const ok = <T>(result: T) => ({ result, hash: 'tx' });

  const load = (id: number) => {
    const r = requests[id];
    if (!r) throw new Error('NoRequest');
    return r;
  };
  const expect = (r: RevealRequest, s: Status) => {
    if (r.status !== s) throw new Error('WrongStatus');
  };
  const mine = (r: RevealRequest, who: string, role: 'anon' | 'requester') => {
    if (r[role] !== who) throw new Error('NotYourRequest');
  };

  return {
    balances,
    config: async () => ({ ...cfg }),
    getProfile: async (a) => profiles.get(a) ?? null,
    getRequest: async (id) => ({ ...load(id) }),
    requestCount: async () => requests.length,

    async setProfile(anon, photoHash, capturedAt) {
      profiles.set(anon, { photoHash, capturedAt, registeredAt: opts.now() });
      return ok(undefined);
    },
    async approve(anon, id, wrappedKey) {
      const r = load(id);
      mine(r, anon, 'anon');
      expect(r, 'Pending');
      Object.assign(r, { wrappedKey, revealedAt: opts.now(), status: 'Revealed' });
      return ok(undefined);
    },
    async decline(anon, id) {
      const r = load(id);
      mine(r, anon, 'anon');
      expect(r, 'Pending');
      pay(r.requester, r.deposit);
      r.status = 'Declined';
      return ok(undefined);
    },
    async reportLeak(anon, id, evidenceHash) {
      const r = load(id);
      mine(r, anon, 'anon');
      expect(r, 'Revealed');
      if (opts.now() >= r.revealedAt + cfg.watchSecs) throw new Error('WindowClosed');
      Object.assign(r, { evidenceHash, status: 'Disputed' });
      return ok(undefined);
    },
    async requestReveal(requester, anon, ndaHash, requesterKey, deposit) {
      if (requester === anon) throw new Error('SelfRequest');
      if (!profiles.has(anon)) throw new Error('NoProfile');
      if (deposit < cfg.minDeposit) throw new Error('DepositTooSmall');
      if (requesterKey.length !== 65 || requesterKey[0] !== 4) throw new Error('BadKey');
      const id = requests.length;
      requests.push({
        id, requester, anon, ndaHash, requesterKey, deposit, status: 'Pending',
        createdAt: opts.now(), revealedAt: 0, wrappedKey: new Uint8Array(), evidenceHash: new Uint8Array(32),
      });
      return ok(id);
    },
    async cancel(requester, id) {
      const r = load(id);
      mine(r, requester, 'requester');
      expect(r, 'Pending');
      pay(r.requester, r.deposit);
      r.status = 'Cancelled';
      return ok(undefined);
    },
    async release(requester, id) {
      const r = load(id);
      mine(r, requester, 'requester');
      expect(r, 'Revealed');
      if (opts.now() < r.revealedAt + cfg.watchSecs) throw new Error('StillLocked');
      pay(r.requester, r.deposit);
      r.status = 'Released';
      return ok(undefined);
    },
    async setArbiterKey(admin, key: Bytes) {
      if (admin !== cfg.admin) throw new Error('auth');
      if (key.length !== 65 || key[0] !== 4) throw new Error('BadKey');
      cfg.arbiterKey = key;
      return ok(undefined);
    },
    async resolve(admin, id, leaked) {
      if (admin !== cfg.admin) throw new Error('auth');
      const r = load(id);
      expect(r, 'Disputed');
      pay(leaked ? r.anon : r.requester, r.deposit);
      r.status = leaked ? 'Slashed' : 'Cleared';
      return ok(undefined);
    },
  };
}
