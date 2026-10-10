// Wallet adapter over Stellar Wallets Kit, limited to wallets that can sign
// plain messages (Unveil derives its encryption keys from those signatures).
// Albedo, Rabet and hardware wallets can't, so they aren't offered.
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { FreighterModule, FREIGHTER_ID } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull';
import { LobstrModule } from '@creit.tech/stellar-wallets-kit/modules/lobstr';
import { HanaModule } from '@creit.tech/stellar-wallets-kit/modules/hana';
import type { SwkAppTheme } from '@creit.tech/stellar-wallets-kit/types';
import { signatureBytes } from './crypto.js';
import { TESTNET, type NetworkConfig } from './types.js';
import type { WalletAdapter } from './wallet.js';

export type { SwkAppTheme };

export interface WalletsKitOptions {
  network?: NetworkConfig;
  /** Colours for the wallet picker. */
  theme?: SwkAppTheme;
}

export interface WalletsKit {
  /** Pass this to `new Unveil({ wallet })`. */
  adapter: WalletAdapter;
  /** Open the wallet picker; resolve to the connected address. */
  connect(): Promise<string>;
  disconnect(): void;
  /** The previously connected address, without prompting, or null. */
  restore(): Promise<string | null>;
  /** Current address, or null. */
  address(): string | null;
  /** e.g. "Freighter", or "" when disconnected. */
  walletName(): string;
  /**
   * Call `cb` when the user switches account inside the wallet. Only Freighter
   * can be watched without opening a popup; for others this is a no-op.
   * Returns an unsubscribe function.
   */
  onAccountChange(cb: (address: string) => void): () => void;
}

// The kit rejects with { code, message } objects; turn them into real errors.
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    const res = await fn();
    const err = (res as { error?: { message?: string } } | undefined)?.error;
    if (err) throw new Error(err.message || 'Wallet error');
    return res;
  } catch (e) {
    throw e instanceof Error ? e : new Error((e as { message?: string })?.message || 'Wallet error');
  }
}

let initialised = false;

export function createWalletsKit({ network = TESTNET, theme }: WalletsKitOptions = {}): WalletsKit {
  if (!initialised) {
    StellarWalletsKit.init({
      modules: [new FreighterModule(), new xBullModule(), new LobstrModule(), new HanaModule()],
      network: network.networkPassphrase as never,
      theme,
    });
    initialised = true;
  } else if (theme) {
    StellarWalletsKit.setTheme(theme);
  }

  let current: string | null = null;

  const selected = () => {
    try {
      return StellarWalletsKit.selectedModule;
    } catch {
      return null;
    }
  };

  const adapter: WalletAdapter = {
    async getAddress() {
      if (!current) throw new Error('Connect a wallet first');
      return current;
    },
    async signTransaction(xdr, opts) {
      const { signedTxXdr } = await wrap(() => StellarWalletsKit.signTransaction(xdr, opts));
      return signedTxXdr;
    },
    async signMessage(message, opts) {
      const { signedMessage } = await wrap(() => StellarWalletsKit.signMessage(message, opts));
      return signatureBytes(signedMessage);
    },
  };

  return {
    adapter,
    async connect() {
      const { address } = await wrap(() => StellarWalletsKit.authModal());
      current = address;
      return address;
    },
    disconnect() {
      current = null;
      StellarWalletsKit.disconnect();
    },
    async restore() {
      try {
        const { address } = await StellarWalletsKit.getAddress();
        if (!selected()) return null; // remembered wallet isn't one we offer
        current = address;
        return address;
      } catch {
        return null;
      }
    },
    address: () => current,
    walletName: () => selected()?.productName ?? '',
    onAccountChange(cb) {
      if (selected()?.productId !== FREIGHTER_ID) return () => {};
      let stopped = false;
      let watcher: { stop(): void } | null = null;
      // Loaded lazily so apps that never use Freighter don't pay for it.
      import('@stellar/freighter-api').then(({ WatchWalletChanges }) => {
        if (stopped) return;
        const w = new WatchWalletChanges(1500);
        watcher = w;
        w.watch(({ address }) => {
          if (address && address !== current) {
            current = address;
            cb(address);
          }
        });
      });
      return () => {
        stopped = true;
        watcher?.stop();
      };
    },
  };
}
