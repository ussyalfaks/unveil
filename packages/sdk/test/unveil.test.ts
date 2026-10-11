import { beforeEach, describe, expect, it } from 'vitest';
import { Unveil, UnveilError, memoryStorage, buildNda, ndaRecipient, toUnits, fromUnits, type ProgressEvent } from '../src/index.js';
import { fakeContract, fakeWallet } from './fakes.js';

const ANON = 'GANON';
const REQ = 'GREQUESTER';
const ADMIN = 'GADMIN';
const TREASURY = 'GTREASURY';
const OWNER = 'GOWNER';
const FEE_TO = 'GFEETO';
const ARB = 'GARBITER';
const MIN = toUnits(50);
const FEE = toUnits(1);
const WATCH = 300;

let clock: number;
let contract: ReturnType<typeof fakeContract>;
let storage: ReturnType<typeof memoryStorage>;
let platform: number;
const photo = crypto.getRandomValues(new Uint8Array(5000));

function as(address: string, app = 'a', extra: { events?: ProgressEvent[]; platform?: number } = {}) {
  return new Unveil({
    contract,
    storage,
    wallet: fakeWallet(address, app),
    platform: extra.platform ?? platform,
    now: () => clock,
    onProgress: extra.events ? (e) => extra.events!.push(e) : undefined,
  });
}

const nda = () =>
  buildNda({ recipient: 'Grace', organisation: 'DAO', recipientWallet: REQ, discloserWallet: ANON, deposit: '50', tokenSymbol: 'XLM', watchSecs: WATCH });

async function revealed() {
  await as(ANON).anon.register({ photo, capturedAt: clock - 5, realName: 'Ada Lovelace' });
  const { result: id } = await as(REQ).requester.request({ anon: ANON, ndaText: nda(), deposit: MIN });
  await as(ANON).anon.approve(id);
  return id;
}

beforeEach(async () => {
  clock = 1_000_000;
  contract = fakeContract({ admin: ADMIN, treasury: TREASURY, protocolFeeBps: 1000, minDeposit: MIN, watchSecs: WATCH, now: () => clock });
  storage = memoryStorage();
  platform = (await as(OWNER, 'a', { platform: 0 }).platforms.register({ name: 'Test DAO', feeTo: FEE_TO, arbiter: ARB, fee: FEE })).result;
});

describe('reveal flow', () => {
  it('lets only the approved requester see the photo and real name', async () => {
    const id = await revealed();
    const opened = await as(REQ).requester.open(id);
    expect(opened.name).toBe('Ada Lovelace');
    expect(opened.jpeg).toEqual(photo);
    expect(ndaRecipient(opened.ndaText)).toBe('Grace');
    expect(opened.request.status).toBe('Revealed');

    await expect(as('GSTRANGER').requester.open(id)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('stores only ciphertext: the photo bytes never appear in storage', async () => {
    await as(ANON).anon.register({ photo, capturedAt: clock });
    const p = await as(ANON).profile(ANON);
    const stored = await storage.get(Buffer.from(p!.photoHash).toString('hex'));
    expect(Buffer.from(stored).includes(Buffer.from(photo.slice(0, 64)))).toBe(false);
  });

  it('refunds the deposit after the watch window; the fee stays spent', async () => {
    const id = await revealed();
    await expect(as(REQ).requester.release(id)).rejects.toThrow(/StillLocked/);
    clock += WATCH;
    await as(REQ).requester.release(id);
    expect(contract.balances.get(REQ)).toBe(-FEE);
  });

  it('reports progress so apps can prompt the user', async () => {
    const events: ProgressEvent[] = [];
    await as(ANON, 'a', { events }).anon.register({ photo, capturedAt: clock });
    expect(events).toEqual([
      { step: 'sign-message', key: 'photo' },
      { step: 'upload', what: 'photo' },
      { step: 'sign-transaction', action: 'register' },
    ]);
  });

  it('lists requests by party', async () => {
    await revealed();
    expect(await as(ANON).requests({ anon: ANON })).toHaveLength(1);
    expect(await as(ANON).requests({ requester: ANON })).toHaveLength(0);
  });
});

describe('platforms and fees', () => {
  it('quotes the fee and how it splits', async () => {
    const q = await as(REQ).quote();
    expect(q.platform.name).toBe('Test DAO');
    expect(q.fee).toBe(FEE);
    expect(q.protocolCut).toBe(FEE / 10n);
    expect(q.platformCut).toBe(FEE - FEE / 10n);
  });

  it('records the platform, fee and arbiter on the request', async () => {
    await as(ANON).anon.register({ photo, capturedAt: clock });
    const { result: id } = await as(REQ).requester.request({ anon: ANON, ndaText: nda(), deposit: MIN });
    const r = await as(REQ).request(id);
    expect([r.platform, r.fee, r.arbiter]).toEqual([platform, FEE, ARB]);
    expect(contract.balances.get(REQ)).toBe(-(MIN + FEE));
  });

  it('pays the fee only when the anon approves', async () => {
    await revealed();
    expect(contract.balances.get(TREASURY)).toBe(FEE / 10n);
    expect(contract.balances.get(FEE_TO)).toBe(FEE - FEE / 10n);
  });

  it('refunds deposit and fee on decline', async () => {
    await as(ANON).anon.register({ photo, capturedAt: clock });
    const { result: id } = await as(REQ).requester.request({ anon: ANON, ndaText: nda(), deposit: MIN });
    await as(ANON).anon.decline(id);
    expect(contract.balances.get(REQ)).toBe(0n);
    expect(contract.balances.get(FEE_TO)).toBeUndefined();
  });

  it('refuses a fee above maxFee', async () => {
    await as(ANON).anon.register({ photo, capturedAt: clock });
    await as(OWNER).platforms.update(platform, { fee: FEE * 5n });
    await expect(
      as(REQ).requester.request({ anon: ANON, ndaText: nda(), deposit: MIN, maxFee: FEE }),
    ).rejects.toThrow(/FeeTooHigh/);
  });

  it('can send a request through another platform', async () => {
    const { result: free } = await as(OWNER).platforms.register({ name: 'Free', feeTo: OWNER, arbiter: ARB, fee: 0n });
    await as(ANON).anon.register({ photo, capturedAt: clock });
    const { result: id } = await as(REQ).requester.request({ anon: ANON, ndaText: nda(), deposit: MIN, platform: free });
    expect((await as(REQ).request(id)).fee).toBe(0n);
    expect(await as(REQ).platforms.list()).toHaveLength(2);
  });

  it('lets only the owner update a platform', async () => {
    await expect(as(REQ).platforms.update(platform, { fee: 0n })).rejects.toThrow(/auth/);
    await as(OWNER).platforms.update(platform, { feeTo: OWNER });
    const p = await as(REQ).platforms.get(platform);
    expect([p.feeTo, p.arbiter, p.fee]).toEqual([OWNER, ARB, FEE]); // untouched fields kept
  });
});

describe('guards', () => {
  it('rejects stale photos', async () => {
    await expect(as(ANON).anon.register({ photo, capturedAt: clock - 601 })).rejects.toMatchObject({ code: 'STALE_PHOTO' });
  });

  it('rejects requests to addresses without a profile, and to yourself', async () => {
    await expect(as(REQ).requester.request({ anon: ANON, ndaText: nda(), deposit: MIN })).rejects.toMatchObject({ code: 'NO_PROFILE' });
    await as(ANON).anon.register({ photo, capturedAt: clock });
    await expect(as(ANON).requester.request({ anon: ANON, ndaText: nda(), deposit: MIN })).rejects.toBeInstanceOf(UnveilError);
  });

  it('stops an anon approving from a different wallet app', async () => {
    await as(ANON).anon.register({ photo, capturedAt: clock });
    const { result: id } = await as(REQ).requester.request({ anon: ANON, ndaText: nda(), deposit: MIN });
    await expect(as(ANON, 'other-app').anon.approve(id)).rejects.toMatchObject({ code: 'WRONG_WALLET' });
  });

  it('stops a requester opening from a different wallet app', async () => {
    const id = await revealed();
    await expect(as(REQ, 'other-app').requester.open(id)).rejects.toMatchObject({ code: 'WRONG_WALLET' });
  });

  it('detects storage that swaps files', async () => {
    const id = await revealed();
    const evil = { ...storage, get: async () => crypto.getRandomValues(new Uint8Array(100)) };
    const u = new Unveil({ contract, storage: evil, wallet: fakeWallet(REQ), platform, now: () => clock });
    await expect(u.requester.open(id)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });
});

describe('disputes', () => {
  it("needs the platform arbiter's key before evidence can be filed", async () => {
    const id = await revealed();
    await expect(as(ANON).anon.reportLeak(id, new Uint8Array([1]))).rejects.toMatchObject({ code: 'NO_ARBITER_KEY' });
  });

  it("seals evidence for the request's arbiter, who resolves the dispute", async () => {
    await as(ARB).arbiter.setupKey();
    const id = await revealed();
    const leak = crypto.getRandomValues(new Uint8Array(2000));
    await as(ANON).anon.reportLeak(id, leak);
    expect((await as(ARB).request(id)).status).toBe('Disputed');

    expect(await as(ARB).arbiter.openEvidence(id)).toEqual(leak);
    await expect(as(ARB, 'other-app').arbiter.openEvidence(id)).rejects.toMatchObject({ code: 'WRONG_WALLET' });
    await expect(as(ADMIN).arbiter.openEvidence(id)).rejects.toMatchObject({ code: 'NOT_ALLOWED' });

    await as(ARB).arbiter.resolve(id, true);
    expect(contract.balances.get(ANON)).toBe(MIN);
    expect((await as(ARB).request(id)).status).toBe('Slashed');
  });

  it("can't seal evidence once the platform has replaced the request's arbiter", async () => {
    await as(ARB).arbiter.setupKey();
    const id = await revealed();
    await as(OWNER).platforms.update(platform, { arbiter: 'GNEWARB' });
    await expect(as(ANON).anon.reportLeak(id, new Uint8Array([1]))).rejects.toMatchObject({ code: 'NO_ARBITER_KEY' });
    // Even once the new arbiter has a key: they can't resolve this request, so don't seal to them.
    await as('GNEWARB').arbiter.setupKey();
    await expect(as(ANON).anon.reportLeak(id, new Uint8Array([1]))).rejects.toMatchObject({ code: 'NO_ARBITER_KEY' });
  });
});

describe('helpers', () => {
  it('converts token amounts exactly', () => {
    expect(toUnits(50)).toBe(500_000_000n);
    expect(toUnits('0.1234567')).toBe(1_234_567n);
    expect(toUnits('1.5')).toBe(15_000_000n);
    expect(fromUnits(500_000_000n)).toBe(50);
    expect(() => toUnits('-1')).toThrow();
  });

  it('builds an NDA with a readable watch period', () => {
    expect(nda()).toContain('for 5 minutes after the reveal');
    expect(buildNda({ recipient: '', recipientWallet: '', discloserWallet: '', deposit: '', tokenSymbol: 'XLM', watchSecs: 604800 })).toContain(
      '7 days',
    );
  });
});
