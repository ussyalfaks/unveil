import { beforeEach, describe, expect, it } from 'vitest';
import { Unveil, UnveilError, memoryStorage, buildNda, ndaRecipient, toUnits, fromUnits, type ProgressEvent } from '../src/index.js';
import { fakeContract, fakeWallet } from './fakes.js';

const ANON = 'GANON';
const REQ = 'GREQUESTER';
const ADMIN = 'GADMIN';
const MIN = toUnits(50);
const WATCH = 300;

let clock: number;
let contract: ReturnType<typeof fakeContract>;
let storage: ReturnType<typeof memoryStorage>;
const photo = crypto.getRandomValues(new Uint8Array(5000));

function as(address: string, app = 'a', events?: ProgressEvent[]) {
  return new Unveil({
    contract,
    storage,
    wallet: fakeWallet(address, app),
    now: () => clock,
    onProgress: events ? (e) => events.push(e) : undefined,
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

beforeEach(() => {
  clock = 1_000_000;
  contract = fakeContract({ admin: ADMIN, minDeposit: MIN, watchSecs: WATCH, now: () => clock });
  storage = memoryStorage();
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

  it('refunds after the watch window', async () => {
    const id = await revealed();
    await expect(as(REQ).requester.release(id)).rejects.toThrow(/StillLocked/);
    clock += WATCH;
    await as(REQ).requester.release(id);
    expect(contract.balances.get(REQ)).toBe(MIN);
  });

  it('reports progress so apps can prompt the user', async () => {
    const events: ProgressEvent[] = [];
    await as(ANON, 'a', events).anon.register({ photo, capturedAt: clock });
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
    const u = new Unveil({ contract, storage: evil, wallet: fakeWallet(REQ), now: () => clock });
    await expect(u.requester.open(id)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });
});

describe('disputes', () => {
  it('needs the arbiter key before evidence can be filed', async () => {
    const id = await revealed();
    await expect(as(ANON).anon.reportLeak(id, new Uint8Array([1]))).rejects.toMatchObject({ code: 'NO_ARBITER_KEY' });
  });

  it('seals evidence for the arbiter, who resolves the dispute', async () => {
    await as(ADMIN).arbiter.setupKey();
    const id = await revealed();
    const leak = crypto.getRandomValues(new Uint8Array(2000));
    await as(ANON).anon.reportLeak(id, leak);
    expect((await as(ADMIN).request(id)).status).toBe('Disputed');

    expect(await as(ADMIN).arbiter.openEvidence(id)).toEqual(leak);
    await expect(as(ADMIN, 'other-app').arbiter.openEvidence(id)).rejects.toMatchObject({ code: 'WRONG_WALLET' });

    await as(ADMIN).arbiter.resolve(id, true);
    expect(contract.balances.get(ANON)).toBe(MIN);
    expect((await as(ADMIN).request(id)).status).toBe('Slashed');
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
