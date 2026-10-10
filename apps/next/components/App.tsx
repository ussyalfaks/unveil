'use client';

import { useEffect, useState } from 'react';
import { AnonPanel } from './AnonPanel';
import { ArbiterPanel } from './ArbiterPanel';
import { AuditPanel } from './AuditPanel';
import { Header, Hero } from './Header';
import { RequesterPanel } from './RequesterPanel';
import { UnveilProvider, useUnveil } from './UnveilProvider';

type Tab = 'anon' | 'requester' | 'audit' | 'arbiter';

const TABS: { id: Tab; label: string }[] = [
  { id: 'anon', label: "I'm anonymous" },
  { id: 'requester', label: 'I want to know who' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'arbiter', label: 'Arbiter' },
];

function Tabs() {
  const { address, cfg } = useUnveil();
  const [tab, setTab] = useState<Tab>('anon');
  const isArbiter = !!address && address === cfg?.admin;

  // Leave the arbiter tab if the wallet switches to a non-arbiter account.
  useEffect(() => {
    if (!isArbiter && tab === 'arbiter') setTab('anon');
  }, [isArbiter, tab]);

  return (
    <>
      <nav className="tabs" role="tablist">
        {TABS.filter((t) => t.id !== 'arbiter' || isArbiter).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'anon' && <AnonPanel />}
        {tab === 'requester' && <RequesterPanel />}
        {tab === 'audit' && <AuditPanel />}
        {tab === 'arbiter' && isArbiter && <ArbiterPanel />}
      </main>
    </>
  );
}

export function App() {
  return (
    <UnveilProvider>
      <Header />
      <Hero />
      <Tabs />
      <footer>Built for Find Your Way · Stellar.</footer>
    </UnveilProvider>
  );
}
