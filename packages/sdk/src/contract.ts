import { Buffer } from 'buffer';
import { contract } from '@stellar/stellar-sdk';
import type { Bytes } from './crypto.js';
import type { Config, NetworkConfig, Profile, RevealRequest, Status, TxResult } from './types.js';
import type { WalletAdapter } from './wallet.js';

/**
 * Typed access to the Unveil Soroban contract. Writes take the acting account
 * explicitly; the implementation signs with the wallet for that account.
 */
export interface ContractApi {
  config(): Promise<Config>;
  getProfile(anon: string): Promise<Profile | null>;
  getRequest(id: number): Promise<RevealRequest>;
  requestCount(): Promise<number>;

  setProfile(anon: string, photoHash: Bytes, capturedAt: number): Promise<TxResult>;
  approve(anon: string, id: number, wrappedKey: Bytes): Promise<TxResult>;
  decline(anon: string, id: number): Promise<TxResult>;
  reportLeak(anon: string, id: number, evidenceHash: Bytes): Promise<TxResult>;

  requestReveal(requester: string, anon: string, ndaHash: Bytes, requesterKey: Bytes, deposit: bigint): Promise<TxResult<number>>;
  cancel(requester: string, id: number): Promise<TxResult>;
  release(requester: string, id: number): Promise<TxResult>;

  /** Admin only. */
  setArbiterKey(admin: string, key: Bytes): Promise<TxResult>;
  /** Admin only. */
  resolve(admin: string, id: number, leaked: boolean): Promise<TxResult>;
}

// Shapes as the generated client returns them.
type Raw = Record<string, any>;
const u8 = (v: unknown) => new Uint8Array(v as ArrayLike<number>);
const buf = (b: Bytes) => Buffer.from(b);
const tag = (s: any): Status => (s && s.tag) || s;

function toRequest(r: Raw): RevealRequest {
  return {
    id: Number(r.id),
    requester: r.requester,
    anon: r.anon,
    ndaHash: u8(r.nda_hash),
    requesterKey: u8(r.requester_key),
    deposit: BigInt(r.deposit),
    status: tag(r.status),
    createdAt: Number(r.created_at),
    revealedAt: Number(r.revealed_at),
    wrappedKey: u8(r.wrapped_key),
    evidenceHash: u8(r.evidence_hash),
  };
}

export interface SorobanContractOptions {
  contractId: string;
  network: NetworkConfig;
  wallet: WalletAdapter;
}

/** The real contract over Soroban RPC. The client spec is fetched from the chain on first use. */
export function sorobanContract({ contractId, network, wallet }: SorobanContractOptions): ContractApi {
  const clients = new Map<string, Promise<any>>();

  function client(signer?: string): Promise<any> {
    const key = signer ?? '';
    if (!clients.has(key)) {
      const p = contract.Client.from({
        contractId,
        networkPassphrase: network.networkPassphrase,
        rpcUrl: network.rpcUrl,
        publicKey: signer,
        signTransaction: async (xdr: string) => ({
          signedTxXdr: await wallet.signTransaction(xdr, { networkPassphrase: network.networkPassphrase, address: signer! }),
          signerAddress: signer,
        }),
      });
      p.catch(() => clients.delete(key)); // don't cache a failed spec fetch
      clients.set(key, p);
    }
    return clients.get(key)!;
  }

  async function read<T>(method: string, args: Raw = {}): Promise<T> {
    const c = await client();
    return (await c[method](args)).result as T;
  }

  async function write<T = void>(signer: string, method: string, args: Raw): Promise<TxResult<T>> {
    const c = await client(signer);
    const tx = await c[method](args);
    const sent = await tx.signAndSend();
    return { result: sent.result as T, hash: sent.sendTransactionResponse?.hash };
  }

  return {
    async config() {
      const c = await read<Raw>('config');
      return {
        admin: c.admin,
        token: c.token,
        minDeposit: BigInt(c.min_deposit),
        watchSecs: Number(c.watch_secs),
        arbiterKey: u8(c.arbiter_key),
      };
    },
    async getProfile(anon) {
      const p = await read<Raw | undefined>('get_profile', { anon });
      return p
        ? { photoHash: u8(p.photo_hash), capturedAt: Number(p.captured_at), registeredAt: Number(p.registered_at) }
        : null;
    },
    async getRequest(id) {
      return toRequest(await read<Raw>('get_request', { id: BigInt(id) }));
    },
    async requestCount() {
      return Number(await read('request_count'));
    },

    setProfile: (anon, photoHash, capturedAt) =>
      write(anon, 'set_profile', { anon, photo_hash: buf(photoHash), captured_at: BigInt(capturedAt) }),
    approve: (anon, id, wrappedKey) => write(anon, 'approve', { anon, id: BigInt(id), wrapped_key: buf(wrappedKey) }),
    decline: (anon, id) => write(anon, 'decline', { anon, id: BigInt(id) }),
    reportLeak: (anon, id, evidenceHash) =>
      write(anon, 'report_leak', { anon, id: BigInt(id), evidence_hash: buf(evidenceHash) }),

    async requestReveal(requester, anon, ndaHash, requesterKey, deposit) {
      const r = await write<bigint | number>(requester, 'request_reveal', {
        requester,
        anon,
        nda_hash: buf(ndaHash),
        requester_key: buf(requesterKey),
        deposit,
      });
      return { ...r, result: Number(r.result) };
    },
    cancel: (requester, id) => write(requester, 'cancel', { requester, id: BigInt(id) }),
    release: (requester, id) => write(requester, 'release', { requester, id: BigInt(id) }),

    setArbiterKey: (admin, key) => write(admin, 'set_arbiter_key', { key: buf(key) }),
    resolve: (admin, id, leaked) => write(admin, 'resolve', { id: BigInt(id), leaked }),
  };
}
