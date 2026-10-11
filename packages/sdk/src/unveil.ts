import * as C from './crypto.js';
import type { Bytes, ProfileContent } from './crypto.js';
import { sorobanContract, type ContractApi } from './contract.js';
import type { BlobStorage } from './storage.js';
import {
  TESTNET,
  type Config,
  type FeeQuote,
  type NetworkConfig,
  type Platform,
  type Profile,
  type RevealRequest,
  type TxResult,
} from './types.js';
import type { WalletAdapter } from './wallet.js';

export type UnveilErrorCode =
  | 'WRONG_WALLET' // the wallet derived a different key than the one used before
  | 'NO_ARBITER_KEY' // the request's arbiter hasn't published an evidence key
  | 'HASH_MISMATCH' // storage returned bytes that don't match the on-chain hash
  | 'STALE_PHOTO' // photo older than maxPhotoAgeSecs
  | 'NO_PROFILE' // address has no Unveil profile
  | 'NOT_ALLOWED' // e.g. a non-requester trying to open a reveal
  | 'BAD_INPUT';

export class UnveilError extends Error {
  constructor(
    readonly code: UnveilErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnveilError';
  }
}

/** Emitted before each step that needs the user, so apps can show a hint. */
export type ProgressEvent =
  | { step: 'sign-message'; key: 'photo' | 'requester' | 'arbiter' }
  | { step: 'upload'; what: 'photo' | 'nda' | 'evidence' }
  | { step: 'sign-transaction'; action: string };

export interface UnveilOptions {
  wallet: WalletAdapter;
  storage: BlobStorage;
  /** Required unless you pass `contract`. */
  contractId?: string;
  /** Defaults to testnet. */
  network?: NetworkConfig;
  /** Override the contract (tests, custom transports). */
  contract?: ContractApi;
  /** Platform that requests go through by default. Default 0 (the deployment's default platform). */
  platform?: number;
  /** Reject photos older than this at registration. Default 600 (10 minutes). */
  maxPhotoAgeSecs?: number;
  onProgress?: (e: ProgressEvent) => void;
  /** Clock override for tests (unix seconds). */
  now?: () => number;
}

export interface RegisterInput {
  /** The stamped JPEG (see `capturePhoto` in "unveil-sdk/browser"). */
  photo: Bytes;
  /** Unix seconds when the photo was taken. */
  capturedAt: number;
  /** Optional real name, revealed together with the photo. Max 80 characters. */
  realName?: string;
}

export interface RevealInput {
  anon: string;
  /** Full NDA text (see `buildNda`). Stored, and its hash goes on-chain. */
  ndaText: string;
  /** Deposit in smallest units (see `toUnits`). */
  deposit: bigint;
  /** Platform to go through. Defaults to the client's `platform`. */
  platform?: number;
  /** Most fee you'll accept, smallest units. Defaults to the platform's current fee. */
  maxFee?: bigint;
}

export interface PlatformInput {
  name: string;
  /** Receives the platform's share of fees. */
  feeTo: string;
  /** Settles disputes on requests made through the platform. */
  arbiter: string;
  /** Fee per reveal, smallest units (see `toUnits`). */
  fee: bigint;
}

export interface OpenedReveal extends ProfileContent {
  request: RevealRequest;
  /** NDA text the requester signed, if storage still has it. */
  ndaText: string | null;
}

const wrongWallet = (what: string) =>
  new UnveilError(
    'WRONG_WALLET',
    `This wallet produced a different ${what} than the one used before. Connect the same wallet app you used originally.`,
  );

export class Unveil {
  readonly network: NetworkConfig;
  readonly contract: ContractApi;
  readonly storage: BlobStorage;
  readonly wallet: WalletAdapter;
  /** Platform that requests go through by default. */
  readonly platform: number;
  private readonly maxPhotoAge: number;
  private readonly progress: (e: ProgressEvent) => void;
  private readonly now: () => number;

  constructor(opts: UnveilOptions) {
    this.network = opts.network ?? TESTNET;
    this.wallet = opts.wallet;
    this.storage = opts.storage;
    if (opts.contract) this.contract = opts.contract;
    else if (opts.contractId) this.contract = sorobanContract({ contractId: opts.contractId, network: this.network, wallet: opts.wallet });
    else throw new UnveilError('BAD_INPUT', 'Pass contractId (or a contract implementation)');
    this.platform = opts.platform ?? 0;
    this.maxPhotoAge = opts.maxPhotoAgeSecs ?? 600;
    this.progress = opts.onProgress ?? (() => {});
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ------------------------------------------------------------------ reads

  config(): Promise<Config> {
    return this.contract.config();
  }

  profile(anon: string): Promise<Profile | null> {
    return this.contract.getProfile(anon);
  }

  request(id: number): Promise<RevealRequest> {
    return this.contract.getRequest(id);
  }

  /** All requests, newest first. Optionally only those involving an address. */
  async requests(filter: { anon?: string; requester?: string; status?: RevealRequest['status'] } = {}): Promise<RevealRequest[]> {
    const n = await this.contract.requestCount();
    const all = await Promise.all([...Array(n).keys()].reverse().map((i) => this.contract.getRequest(i)));
    return all.filter(
      (r) =>
        (!filter.anon || r.anon === filter.anon) &&
        (!filter.requester || r.requester === filter.requester) &&
        (!filter.status || r.status === filter.status),
    );
  }

  /** The NDA text for a request, or null if storage doesn't have it. */
  async ndaText(request: RevealRequest): Promise<string | null> {
    try {
      return new TextDecoder().decode(await this.fetchVerified(request.ndaHash));
    } catch {
      return null;
    }
  }

  /** What a reveal through `platform` costs, and how the fee splits. */
  async quote(platform = this.platform): Promise<FeeQuote> {
    const [p, cfg] = await Promise.all([this.contract.getPlatform(platform), this.config()]);
    const protocolCut = (p.fee * BigInt(cfg.protocolFeeBps)) / 10_000n;
    return { platform: p, fee: p.fee, protocolCut, platformCut: p.fee - protocolCut };
  }

  /** Unix seconds when the deposit of a revealed request unlocks. */
  async unlocksAt(request: RevealRequest): Promise<number> {
    return request.revealedAt + (await this.config()).watchSecs;
  }

  // ------------------------------------------------------------------ platforms

  readonly platforms = {
    get: (id: number): Promise<Platform> => this.contract.getPlatform(id),

    list: async (): Promise<Platform[]> => {
      const n = await this.contract.platformCount();
      return Promise.all([...Array(n).keys()].map((i) => this.contract.getPlatform(i)));
    },

    /** Register a platform; the connected wallet becomes its owner. Resolves to its id. */
    register: async (input: PlatformInput): Promise<TxResult<number>> => {
      const me = await this.wallet.getAddress();
      this.progress({ step: 'sign-transaction', action: 'register_platform' });
      return this.contract.registerPlatform(me, input.name, input.feeTo, input.arbiter, input.fee);
    },

    /** Owner only. Fields you leave out keep their current value. A new arbiter must set up a new key. */
    update: async (id: number, changes: Partial<Omit<PlatformInput, 'name'>>): Promise<TxResult> => {
      const me = await this.wallet.getAddress();
      const p = await this.contract.getPlatform(id);
      this.progress({ step: 'sign-transaction', action: 'update_platform' });
      return this.contract.updatePlatform(me, id, changes.feeTo ?? p.feeTo, changes.arbiter ?? p.arbiter, changes.fee ?? p.fee);
    },
  };

  // ------------------------------------------------------------------ anon

  readonly anon = {
    /** Encrypt the photo (and optional name), store it, and register its hash on-chain. */
    register: async ({ photo, capturedAt, realName = '' }: RegisterInput): Promise<TxResult> => {
      if (this.now() - capturedAt > this.maxPhotoAge)
        throw new UnveilError('STALE_PHOTO', `Photo is older than ${Math.round(this.maxPhotoAge / 60)} minutes. Take a fresh one.`);
      const bundle = C.packProfile(realName, photo);
      const me = await this.wallet.getAddress();
      const K = await this.photoKey(me);
      const sealed = await C.encryptPhoto(K, bundle);
      await this.putVerified(sealed, 'photo');
      this.progress({ step: 'sign-transaction', action: 'register' });
      return this.contract.setProfile(me, C.sha256Bytes(sealed), capturedAt);
    },

    /** Reveal to the requester: post the photo key, encrypted to their key. */
    approve: async (id: number): Promise<TxResult> => {
      const me = await this.wallet.getAddress();
      const r = await this.contract.getRequest(id);
      if (r.anon !== me) throw new UnveilError('NOT_ALLOWED', 'This request is not addressed to you');
      const profile = await this.contract.getProfile(me);
      if (!profile) throw new UnveilError('NO_PROFILE', 'Register a photo first');
      const K = await this.photoKey(me);
      // Make sure this key really opens the registered photo before handing it over.
      await C.decryptPhoto(K, await this.fetchVerified(profile.photoHash)).catch(() => {
        throw wrongWallet('photo key');
      });
      const wrapped = await C.wrapKey(K, r.requesterKey);
      this.progress({ step: 'sign-transaction', action: 'approve' });
      return this.contract.approve(me, id, wrapped);
    },

    decline: async (id: number): Promise<TxResult> => {
      this.progress({ step: 'sign-transaction', action: 'decline' });
      return this.contract.decline(await this.wallet.getAddress(), id);
    },

    /** Report a leak with the leaked image. It's sealed so only the request's arbiter can open it. */
    reportLeak: async (id: number, evidence: Bytes): Promise<TxResult> => {
      const arbiterKey = await this.evidenceKey(await this.contract.getRequest(id));
      const sealed = await C.sealEvidence(arbiterKey, evidence);
      await this.putVerified(sealed, 'evidence');
      this.progress({ step: 'sign-transaction', action: 'report_leak' });
      return this.contract.reportLeak(await this.wallet.getAddress(), id, C.sha256Bytes(sealed));
    },
  };

  // ------------------------------------------------------------------ requester

  readonly requester = {
    /** Sign the NDA and lock the deposit plus the platform fee. Resolves to the new request id. */
    request: async ({ anon, ndaText, deposit, platform = this.platform, maxFee }: RevealInput): Promise<TxResult<number>> => {
      const me = await this.wallet.getAddress();
      if (me === anon) throw new UnveilError('BAD_INPUT', "You can't request your own reveal");
      if (!(await this.contract.getProfile(anon))) throw new UnveilError('NO_PROFILE', 'This address has no Unveil profile yet');
      const ndaBytes = new TextEncoder().encode(ndaText);
      await this.putVerified(ndaBytes, 'nda'); // so the anon can read exactly what was signed
      const fee = maxFee ?? (await this.contract.getPlatform(platform)).fee;
      const secret = await this.requesterSecret(me);
      this.progress({ step: 'sign-transaction', action: 'request_reveal' });
      return this.contract.requestReveal(me, anon, platform, C.sha256Bytes(ndaBytes), C.publicKeyOf(secret), deposit, fee);
    },

    cancel: async (id: number): Promise<TxResult> => {
      this.progress({ step: 'sign-transaction', action: 'cancel' });
      return this.contract.cancel(await this.wallet.getAddress(), id);
    },

    /** Take the deposit back after the watch period. */
    release: async (id: number): Promise<TxResult> => {
      this.progress({ step: 'sign-transaction', action: 'release' });
      return this.contract.release(await this.wallet.getAddress(), id);
    },

    /** Decrypt an approved reveal: the photo and the real name, if shared. */
    open: async (id: number): Promise<OpenedReveal> => {
      const me = await this.wallet.getAddress();
      const request = await this.contract.getRequest(id);
      if (request.requester !== me) throw new UnveilError('NOT_ALLOWED', 'Only the requester can open this reveal');
      if (!request.wrappedKey.length) throw new UnveilError('NOT_ALLOWED', 'This request has not been approved');
      const secret = await this.requesterSecret(me);
      if (!C.bytesEqual(C.publicKeyOf(secret), request.requesterKey)) throw wrongWallet('viewing key');
      const K = await C.unwrapKey(request.wrappedKey, secret);
      const profile = await this.contract.getProfile(request.anon);
      if (!profile) throw new UnveilError('NO_PROFILE', 'The anon no longer has a profile');
      const content = C.unpackProfile(await C.decryptPhoto(K, await this.fetchVerified(profile.photoHash)));
      return { ...content, request, ndaText: await this.ndaText(request) };
    },
  };

  // ------------------------------------------------------------------ arbiter

  readonly arbiter = {
    /** Derive the evidence key from a signature and publish its public half. The platform's arbiter only. */
    setupKey: async (platform = this.platform): Promise<TxResult> => {
      const me = await this.wallet.getAddress();
      const p = await this.contract.getPlatform(platform);
      if (p.arbiter !== me) throw new UnveilError('NOT_ALLOWED', `Only the arbiter of platform #${platform} can set its evidence key`);
      const secret = await this.arbiterSecret(me);
      this.progress({ step: 'sign-transaction', action: 'set_arbiter_key' });
      return this.contract.setArbiterKey(me, platform, C.publicKeyOf(secret));
    },

    /** Decrypt the leak evidence attached to a disputed request. The request's arbiter only. */
    openEvidence: async (id: number): Promise<Bytes> => {
      const me = await this.wallet.getAddress();
      const request = await this.contract.getRequest(id);
      if (request.arbiter !== me) throw new UnveilError('NOT_ALLOWED', 'Only the arbiter of this request can open its evidence');
      const key = await this.evidenceKey(request);
      const sealed = await this.fetchVerified(request.evidenceHash);
      const secret = await this.arbiterSecret(me);
      if (!C.bytesEqual(C.publicKeyOf(secret), key)) throw wrongWallet('arbiter key');
      return C.openEvidence(sealed, secret);
    },

    /** `leaked = true` pays the deposit to the anon; false refunds the requester. The request's arbiter only. */
    resolve: async (id: number, leaked: boolean): Promise<TxResult> => {
      this.progress({ step: 'sign-transaction', action: 'resolve' });
      return this.contract.resolve(await this.wallet.getAddress(), id, leaked);
    },
  };

  // ------------------------------------------------------------------ internals

  /** The evidence key of the arbiter recorded on a request. */
  private async evidenceKey(request: RevealRequest): Promise<Bytes> {
    const p = await this.contract.getPlatform(request.platform);
    if (p.arbiter !== request.arbiter)
      throw new UnveilError('NO_ARBITER_KEY', "This platform has replaced the request's arbiter, so evidence can't be sealed for them.");
    if (!p.arbiterKey.length)
      throw new UnveilError('NO_ARBITER_KEY', "The arbiter hasn't set up an evidence key yet, so evidence can't be encrypted.");
    return p.arbiterKey;
  }

  private async sign(address: string, message: string): Promise<Bytes> {
    return this.wallet.signMessage(message, { networkPassphrase: this.network.networkPassphrase, address });
  }

  private async photoKey(address: string): Promise<Bytes> {
    this.progress({ step: 'sign-message', key: 'photo' });
    return C.photoKeyFromSignature(await this.sign(address, C.PHOTO_KEY_MESSAGE(address)));
  }

  private async requesterSecret(address: string): Promise<Bytes> {
    this.progress({ step: 'sign-message', key: 'requester' });
    return C.requesterSecretFromSignature(await this.sign(address, C.REQUESTER_KEY_MESSAGE(address)));
  }

  private async arbiterSecret(address: string): Promise<Bytes> {
    this.progress({ step: 'sign-message', key: 'arbiter' });
    return C.arbiterSecretFromSignature(await this.sign(address, C.ARBITER_KEY_MESSAGE(address)));
  }

  private async putVerified(bytes: Bytes, what: 'photo' | 'nda' | 'evidence'): Promise<void> {
    this.progress({ step: 'upload', what });
    const hex = await this.storage.put(bytes);
    if (hex !== C.toHex(C.sha256Bytes(bytes))) throw new UnveilError('HASH_MISMATCH', 'Storage returned the wrong hash');
  }

  private async fetchVerified(hash: Bytes): Promise<Bytes> {
    const bytes = await this.storage.get(C.toHex(hash));
    if (!C.bytesEqual(C.sha256Bytes(bytes), hash))
      throw new UnveilError('HASH_MISMATCH', 'Stored file does not match its on-chain hash');
    return bytes;
  }
}
