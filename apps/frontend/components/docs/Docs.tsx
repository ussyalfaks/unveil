'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CONTRACT_ID, EXPLORER, NETWORK_LABEL } from '@/lib/config';
import { DEVELOPER_SECTIONS, DevelopersDocs } from './DevelopersDocs';
import { PLATFORM_SECTIONS, PlatformDocs } from './PlatformDocs';

type Tab = 'developers' | 'platforms';
const TABS: { id: Tab; label: string }[] = [
  { id: 'developers', label: 'For developers' },
  { id: 'platforms', label: 'Platform integration' },
];

export function Docs() {
  const [tab, setTab] = useState<Tab>('developers');

  // Keep the tab in the URL hash so links like /docs#platforms work.
  useEffect(() => {
    const fromHash = () => setTab(location.hash === '#platforms' ? 'platforms' : 'developers');
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const select = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
    window.scrollTo({ top: 0 });
  };

  const sections = tab === 'developers' ? DEVELOPER_SECTIONS : PLATFORM_SECTIONS;

  return (
    <>
      <header className="top">
        <Link href="/" className="brand">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <circle cx="16" cy="13" r="7" fill="currentColor" />
            <path d="M12 18h8l2 11H10z" fill="currentColor" />
          </svg>
          <span>Unveil</span>
          <span className="net">docs</span>
        </Link>
        <nav className="top-links">
          <a className="link" href="https://www.npmjs.com/package/unveil-sdk" target="_blank" rel="noopener">
            npm ↗
          </a>
          <Link className="link" href="/">
            ← back to app
          </Link>
        </nav>
      </header>

      <section className="hero docs-hero">
        <p className="boot" aria-hidden="true">
          <span>$ npm install unveil-sdk</span>
          <span>
            <span className="ok">[ OK ]</span> types included · {NETWORK_LABEL.toLowerCase()}
          </span>
        </p>
        <h1>
          Build with <em>Unveil</em>
        </h1>
        <p>
          Add controlled identity reveal to your Stellar app: encrypted live photos, NDAs signed on-chain, deposits that make leaking
          expensive, and a watermarked viewer.
        </p>
      </section>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => select(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main className="docs">
        <aside className="docs-toc" aria-label="On this page">
          <p className="muted tiny">on this page</p>
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </aside>
        <article className="docs-body">
          {tab === 'developers' ? <DevelopersDocs contractId={CONTRACT_ID} /> : <PlatformDocs contractId={CONTRACT_ID} explorer={EXPLORER} />}
        </article>
      </main>

      <footer>Built for Find Your Way · Stellar.</footer>
    </>
  );
}
