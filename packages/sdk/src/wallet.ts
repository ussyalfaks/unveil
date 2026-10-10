import type { Bytes } from './crypto.js';

export interface SignOptions {
  networkPassphrase: string;
  address: string;
}

/**
 * Anything that can sign for a Stellar account. The wallet MUST sign messages
 * deterministically (plain ed25519 does): Unveil derives its encryption keys
 * from those signatures, so the same message has to give the same bytes every
 * time. See `createWalletsKit` in "@unveil/sdk/wallets-kit" for a ready-made
 * adapter over Freighter, xBull, LOBSTR and Hana.
 */
export interface WalletAdapter {
  /** The connected account (G…). Reject if nothing is connected. */
  getAddress(): Promise<string>;
  /** Sign a transaction envelope; resolve to the signed XDR. */
  signTransaction(xdr: string, opts: SignOptions): Promise<string>;
  /** Sign a plain message; resolve to the raw signature bytes. */
  signMessage(message: string, opts: SignOptions): Promise<Bytes>;
}
