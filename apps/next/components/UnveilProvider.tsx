'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Unveil, httpStorage, type Config, type ProgressEvent } from '@unveil/sdk';
import type { WalletsKit } from '@unveil/sdk/wallets-kit';
import { CONTRACT_ID, NETWORK } from '@/lib/config';
import { errorMessage, short } from '@/lib/format';

export type ToastKind = 'info' | 'ok' | 'error';
interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
}

interface UnveilContext {
  unveil: Unveil | null;
  address: string | null;
  walletName: string;
  cfg: Config | null;
  /** Bumps after every successful action, so panels reload. */
  version: number;
  connecting: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  toast(msg: string, kind?: ToastKind): void;
  refresh(): void;
}

const Ctx = createContext<UnveilContext | null>(null);

export function useUnveil(): UnveilContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUnveil must be used inside <UnveilProvider>');
  return c;
}

// Wallet picker colours, matching the terminal theme.
const KIT_THEME = {
  background: '#0a0f0b',
  'background-secondary': '#0f1712',
  'foreground-strong': '#39ff6a',
  foreground: '#c8ffd4',
  'foreground-secondary': '#7fdc96',
  primary: '#39ff6a',
  'primary-foreground': '#021a08',
  transparent: 'rgba(0,0,0,0)',
  lighter: '#0f1712',
  light: '#1c3a24',
  'light-gray': '#2f6b3f',
  gray: '#4f8a5e',
  danger: '#ff3b5c',
  border: '#2f6b3f',
  shadow: '0 0 30px rgba(57,255,106,.18)',
  'border-radius': '2px',
  'font-family': "'JetBrains Mono', ui-monospace, monospace",
};

function hint(e: ProgressEvent, wallet: string): string | null {
  const w = wallet || 'your wallet';
  if (e.step === 'sign-message')
    return {
      photo: `Sign the message in ${w} to derive your photo key (no funds move).`,
      requester: `Sign in ${w} to derive your viewing key (no funds move).`,
      arbiter: `Sign in ${w} to derive your arbiter key (no funds move).`,
    }[e.key];
  if (e.step === 'sign-transaction') return `Confirm the transaction in ${w}.`;
  return null;
}

export function UnveilProvider({ children }: { children: ReactNode }) {
  const [unveil, setUnveil] = useState<Unveil | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [version, setVersion] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const kitRef = useRef<WalletsKit | null>(null);
  const started = useRef(false);

  const toast = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // The wallet kit touches window/localStorage, so load it on the client only.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!CONTRACT_ID) {
      toast('No contract set. Put NEXT_PUBLIC_CONTRACT_ID in .env.local (see README).', 'error');
      return;
    }
    (async () => {
      const { createWalletsKit } = await import('@unveil/sdk/wallets-kit');
      const kit = createWalletsKit({ network: NETWORK, theme: KIT_THEME });
      kitRef.current = kit;
      setUnveil(
        new Unveil({
          contractId: CONTRACT_ID,
          network: NETWORK,
          wallet: kit.adapter,
          storage: httpStorage('/api/blob'),
          onProgress: (e) => {
            const msg = hint(e, kit.walletName());
            if (msg) toast(msg);
          },
        }),
      );
      setAddress(await kit.restore());
    })().catch((e) => toast(errorMessage(e), 'error'));
  }, [toast]);

  // Contract settings (readable without a wallet).
  useEffect(() => {
    if (!unveil) return;
    unveil
      .config()
      .then(setCfg)
      .catch((e) => toast(errorMessage(e), 'error'));
  }, [unveil, version, toast]);

  // Follow account switches inside the wallet (Freighter only).
  useEffect(() => {
    if (!address || !kitRef.current) return;
    return kitRef.current.onAccountChange((next) => {
      toast(`Switched to ${short(next)}`);
      setAddress(next);
    });
  }, [address, toast]);

  const connect = useCallback(async () => {
    if (!kitRef.current) return;
    setConnecting(true);
    try {
      setAddress(await kitRef.current.connect());
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setConnecting(false);
    }
  }, [toast]);

  const disconnect = useCallback(() => {
    kitRef.current?.disconnect();
    setAddress(null);
    toast('Wallet disconnected');
  }, [toast]);

  return (
    <Ctx.Provider
      value={{
        unveil,
        address,
        walletName: address ? (kitRef.current?.walletName() ?? '') : '',
        cfg,
        version,
        connecting,
        connect,
        disconnect,
        toast,
        refresh,
      }}
    >
      {children}
      <div id="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
