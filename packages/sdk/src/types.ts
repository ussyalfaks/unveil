import type { Bytes } from './crypto.js';

export type Status =
  | 'Pending' // waiting for the anon to approve or decline
  | 'Declined' // anon declined; deposit refunded
  | 'Cancelled' // requester withdrew before an answer; deposit refunded
  | 'Revealed' // identity revealed; deposit locked during the watch period
  | 'Released' // watch period ended with no leak report; deposit refunded
  | 'Disputed' // anon reported a leak; waiting for the arbiter
  | 'Slashed' // arbiter confirmed the leak; deposit paid to the anon
  | 'Cleared'; // arbiter rejected the leak report; deposit refunded

export interface Profile {
  /** SHA-256 of the encrypted photo blob. */
  photoHash: Bytes;
  /** When the photo was taken, per the anon's device (unix seconds). */
  capturedAt: number;
  /** When the profile reached the chain (ledger time, unix seconds). */
  registeredAt: number;
}

export interface RevealRequest {
  id: number;
  requester: string;
  anon: string;
  /** SHA-256 of the NDA text the requester signed. */
  ndaHash: Bytes;
  /** Requester's 65-byte P-256 public key. */
  requesterKey: Bytes;
  /** Deposit in the token's smallest unit (7 decimals for Stellar assets). */
  deposit: bigint;
  /** Platform the request came through. */
  platform: number;
  /** Platform fee locked with the deposit; paid out only if the anon approves. */
  fee: bigint;
  /** Who settles a dispute on this request (fixed when the request was made). */
  arbiter: string;
  status: Status;
  createdAt: number;
  revealedAt: number;
  /** Photo key encrypted to requesterKey (empty until revealed). */
  wrappedKey: Bytes;
  /** SHA-256 of the sealed leak evidence (all zeros if none). */
  evidenceHash: Bytes;
}

export interface Config {
  /** Protocol admin: sets the protocol fee. */
  admin: string;
  /** Token contract used for deposits and fees. */
  token: string;
  minDeposit: bigint;
  /** How long a deposit stays locked after a reveal (seconds). */
  watchSecs: number;
  /** Receives the protocol's cut of every platform fee. */
  treasury: string;
  /** Protocol's cut in basis points of the fee (1000 = 10%). */
  protocolFeeBps: number;
}

export interface Platform {
  id: number;
  name: string;
  /** Can change feeTo, arbiter and fee. */
  owner: string;
  /** Receives the platform's share of fees. */
  feeTo: string;
  /** Settles disputes on requests made through this platform. */
  arbiter: string;
  /** Arbiter's P-256 public key for evidence (empty until set). */
  arbiterKey: Bytes;
  /** Fee per reveal, smallest units. */
  fee: bigint;
}

/** What a reveal through a platform costs, and where the fee goes. */
export interface FeeQuote {
  platform: Platform;
  /** Total fee the requester pays on approval. */
  fee: bigint;
  /** Part of the fee that goes to the protocol treasury. */
  protocolCut: bigint;
  /** Part of the fee that goes to the platform. */
  platformCut: bigint;
}

export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** Block explorer base URL, for building links. */
  explorerUrl?: string;
}

export const TESTNET: NetworkConfig = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  explorerUrl: 'https://stellar.expert/explorer/testnet',
};

export const MAINNET: NetworkConfig = {
  rpcUrl: 'https://mainnet.sorobanrpc.com',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  explorerUrl: 'https://stellar.expert/explorer/public',
};

/** Result of a submitted transaction. */
export interface TxResult<T = void> {
  result: T;
  /** Transaction hash, when the network returned one. */
  hash?: string;
}

/** Stellar assets use 7 decimals. */
export const TOKEN_DECIMALS = 7;

/** "50" or 50 → 500000000n (smallest units). */
export function toUnits(amount: number | string, decimals = TOKEN_DECIMALS): bigint {
  const [whole, frac = ''] = String(amount).trim().split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error(`Invalid amount: ${amount}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** 500000000n → 50 */
export function fromUnits(units: bigint, decimals = TOKEN_DECIMALS): number {
  return Number(units) / 10 ** decimals;
}
