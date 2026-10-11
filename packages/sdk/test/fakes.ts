import { sha256 } from '@noble/hashes/sha2.js';
import type { ContractApi } from '../src/contract.js';
import { concat, type Bytes } from '../src/crypto.js';
import type { Config, Platform, Profile, RevealRequest, Status } from '../src/types.js';
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

const isKey = (k: Bytes) => k.length === 65 && k[0] === 4;

/** In-memory twin of the Soroban contract's rules (statuses, auth, fees, watch window). */
export function fakeContract(opts: {
  admin: string;
  treasury: string;
  protocolFeeBps: number;
  minDeposit: bigint;
  watchSecs: number;
  now: () => number;
}): ContractApi & { balances: Map<string, bigint> } {
  const cfg: Config = {
    admin: opts.admin,
    token: 'TOKEN',
    minDeposit: opts.minDeposit,
    watchSecs: opts.watchSecs,
    treasury: opts.treasury,
    protocolFeeBps: opts.protocolFeeBps,
  };
  const profiles = new Map<string, Profile>();
  const requests: RevealRequest[] = [];
  const platforms: Platform[] = [];
  /** Net token movement per address (negative = paid in). */
  const balances = new Map<string, bigint>();
  const move = (who: string, amt: bigint) => balances.set(who, (balances.get(who) ?? 0n) + amt);
  const ok = <T>(result: T) => ({ result, hash: 'tx' });

  const load = (id: number) => {
    const r = requests[id];
    if (!r) throw new Error('NoRequest');
    return r;
  };
  const platform = (id: number) => {
    const p = platforms[id];
    if (!p) throw new Error('UnknownPlatform');
    return p;
  };
  const expect = (r: RevealRequest, s: Status) => {
    if (r.status !== s) throw new Error('WrongStatus');
  };
  const mine = (r: RevealRequest, who: string, role: 'anon' | 'requester') => {
    if (r[role] !== who) throw new Error('NotYourRequest');
  };
  const auth = (who: string, expected: string) => {
    if (who !== expected) throw new Error('auth');
  };

  return {
    balances,
    config: async () => ({ ...cfg }),
    getProfile: async (a) => profiles.get(a) ?? null,
    getRequest: async (id) => ({ ...load(id) }),
    requestCount: async () => requests.length,
    getPlatform: async (id) => ({ ...platform(id) }),
    platformCount: async () => platforms.length,

    async setProfile(anon, photoHash, capturedAt) {
      profiles.set(anon, { photoHash, capturedAt, registeredAt: opts.now() });
      return ok(undefined);
    },
    async approve(anon, id, wrappedKey) {
      const r = load(id);
      mine(r, anon, 'anon');
      expect(r, 'Pending');
      const cut = (r.fee * BigInt(cfg.protocolFeeBps)) / 10_000n;
      move(cfg.treasury, cut);
      move(platform(r.platform).feeTo, r.fee - cut);
      Object.assign(r, { wrappedKey, revealedAt: opts.now(), status: 'Revealed' });
      return ok(undefined);
    },
    async decline(anon, id) {
      const r = load(id);
      mine(r, anon, 'anon');
      expect(r, 'Pending');
      move(r.requester, r.deposit + r.fee);
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
    async requestReveal(requester, anon, platformId, ndaHash, requesterKey, deposit, maxFee) {
      if (requester === anon) throw new Error('SelfRequest');
      if (!profiles.has(anon)) throw new Error('NoProfile');
      if (deposit < cfg.minDeposit) throw new Error('DepositTooSmall');
      if (!isKey(requesterKey)) throw new Error('BadKey');
      const p = platform(platformId);
      if (p.fee > maxFee) throw new Error('FeeTooHigh');
      move(requester, -(deposit + p.fee));
      const id = requests.length;
      requests.push({
        id, requester, anon, ndaHash, requesterKey, deposit, platform: platformId, fee: p.fee, arbiter: p.arbiter,
        status: 'Pending', createdAt: opts.now(), revealedAt: 0, wrappedKey: new Uint8Array(), evidenceHash: new Uint8Array(32),
      });
      return ok(id);
    },
    async cancel(requester, id) {
      const r = load(id);
      mine(r, requester, 'requester');
      expect(r, 'Pending');
      move(r.requester, r.deposit + r.fee);
      r.status = 'Cancelled';
      return ok(undefined);
    },
    async release(requester, id) {
      const r = load(id);
      mine(r, requester, 'requester');
      expect(r, 'Revealed');
      if (opts.now() < r.revealedAt + cfg.watchSecs) throw new Error('StillLocked');
      move(r.requester, r.deposit);
      r.status = 'Released';
      return ok(undefined);
    },
    async registerPlatform(owner, name, feeTo, arbiter, fee) {
      if (!name || name.length > 64) throw new Error('BadName');
      if (fee < 0n) throw new Error('BadFee');
      const id = platforms.length;
      platforms.push({ id, name, owner, feeTo, arbiter, arbiterKey: new Uint8Array(), fee });
      return ok(id);
    },
    async updatePlatform(owner, id, feeTo, arbiter, fee) {
      const p = platform(id);
      auth(owner, p.owner);
      if (fee < 0n) throw new Error('BadFee');
      if (p.arbiter !== arbiter) p.arbiterKey = new Uint8Array();
      Object.assign(p, { feeTo, arbiter, fee });
      return ok(undefined);
    },
    async setArbiterKey(arbiter, platformId, key) {
      const p = platform(platformId);
      auth(arbiter, p.arbiter);
      if (!isKey(key)) throw new Error('BadKey');
      p.arbiterKey = key;
      return ok(undefined);
    },
    async resolve(arbiter, id, leaked) {
      const r = load(id);
      auth(arbiter, r.arbiter);
      expect(r, 'Disputed');
      move(leaked ? r.anon : r.requester, r.deposit);
      r.status = leaked ? 'Slashed' : 'Cleared';
      return ok(undefined);
    },
    async setProtocolFee(admin, bps, treasury) {
      auth(admin, cfg.admin);
      if (bps > 3000) throw new Error('BadFee');
      Object.assign(cfg, { protocolFeeBps: bps, treasury });
      return ok(undefined);
    },
  };
}
