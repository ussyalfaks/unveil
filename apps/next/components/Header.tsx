'use client';

import { NETWORK_LABEL } from '@/lib/config';
import { short } from '@/lib/format';
import { useUnveil } from './UnveilProvider';

export function Header() {
  const { address, walletName, connecting, connect, disconnect } = useUnveil();
  const on = !!address;
  const label = on ? 'Disconnect wallet' : 'Connect wallet';
  return (
    <header className="top">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
          <circle cx="16" cy="13" r="7" fill="currentColor" />
          <path d="M12 18h8l2 11H10z" fill="currentColor" />
        </svg>
        <span>Unveil</span>
        <span className="net">{NETWORK_LABEL}</span>
      </div>
      <div className="wallet">
        {on && (
          <span className="wallet-addr" title={`${address} (${walletName})`}>
            {short(address)}
          </span>
        )}
        <button
          id="connect"
          type="button"
          className={`power ${on ? 'on' : 'primary'}${connecting ? ' busy' : ''}`}
          aria-label={label}
          title={label}
          disabled={connecting}
          onClick={() => (on ? disconnect() : connect())}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2v10" />
            <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
          </svg>
          <span className="label">Connect</span>
        </button>
      </div>
    </header>
  );
}

export function Hero() {
  return (
    <section className="hero">
      <p className="boot" aria-hidden="true">
        <span>$ unveil --network {NETWORK_LABEL.split(' ')[1]}</span>
        <span>
          <span className="ok">[ OK ]</span> soroban contract loaded
        </span>
        <span>
          <span className="ok">[ OK ]</span> e2e encryption: p256 + aes-256-gcm
        </span>
        <span>
          <span className="ok">[ OK ]</span> watermark engine armed
        </span>
      </p>
      <h1>
        Show your face to <em>one</em> party.
        <br />
        Make leaking it cost them.
      </h1>
      <p>
        Pseudonymous builders reveal who they are to a DAO, investor or employer, and nobody else. The requester signs an NDA and
        locks a deposit on Stellar. Every peek is watermarked with their wallet. Leak it, lose the deposit.
      </p>
      <ol className="flow">
        <li>
          <b>1</b> Anon registers a live photo, encrypted in their browser
        </li>
        <li>
          <b>2</b> Requester signs the NDA and locks a deposit
        </li>
        <li>
          <b>3</b> Anon approves; only that requester can decrypt
        </li>
        <li>
          <b>4</b> Requester peeks through a watermarked keyhole
        </li>
        <li>
          <b>5</b> No leak reported → deposit back. Proven leak → anon is paid
        </li>
      </ol>
    </section>
  );
}
