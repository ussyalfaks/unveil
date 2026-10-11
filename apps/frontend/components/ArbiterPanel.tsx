'use client';

import { useEffect, useRef, useState } from 'react';
import { crypto as C } from 'unveil-sdk';
import { fmtAmt, short } from '@/lib/format';
import { ActionButton, StatusPill, useLoad } from './ui';
import { useUnveil } from './UnveilProvider';

export function ArbiterPanel() {
  const { unveil, address, quote, version, toast, refresh } = useUnveil();
  // Only disputes this wallet is the recorded arbiter for.
  const { data: disputes } = useLoad(
    () => (unveil && address ? unveil.requests({ status: 'Disputed' }).then((rs) => rs.filter((r) => r.arbiter === address)) : null),
    [unveil, address, version],
  );
  const [evidence, setEvidence] = useState<{ id: number; url: string } | null>(null);
  const hasKey = !!quote?.platform.arbiterKey.length;

  return (
    <section className="panel">
      <div className="box">
        <h2>Evidence key</h2>
        <p className="muted">
          {!quote
            ? 'Loading…'
            : hasKey
              ? `Set for platform #${quote.platform.id} "${quote.platform.name}". Leak evidence is encrypted to your key, and only you can open it.`
              : "Not set. Until you set it, anons can't submit leak evidence. One signature derives it; the public half is stored on-chain."}
        </p>
        {quote && !hasKey && (
          <div className="actions">
            <ActionButton
              label="Set up arbiter key"
              busyLabel="Setting up…"
              className="primary"
              onClick={async () => {
                await unveil!.arbiter.setupKey();
                toast('Arbiter key set. Anons can now submit encrypted evidence.', 'ok');
                refresh();
              }}
            />
          </div>
        )}
      </div>
      <h2 className="section-title">Open disputes</h2>
      <div className="cards">
        {!disputes ? (
          <p className="muted">Loading…</p>
        ) : !disputes.length ? (
          <p className="muted">No open disputes.</p>
        ) : (
          disputes.map((r) => (
            <article key={r.id} className="card">
              <header>
                <span className="mono">#{r.id}</span>
                <StatusPill status={r.status} />
              </header>
              <p>
                Anon <span className="mono">{short(r.anon)}</span> says <span className="mono">{short(r.requester)}</span> leaked. Deposit{' '}
                {fmtAmt(r.deposit)}.
              </p>
              <p className="mono tiny">evidence sha256 {C.toHex(r.evidenceHash)}</p>
              <p className="muted">Check the leaked image&apos;s watermark: it names the viewer&apos;s wallet and reveal number.</p>
              <div className="actions">
                <ActionButton
                  label="View evidence"
                  busyLabel="Decrypting…"
                  className="primary"
                  onClick={async () => {
                    const img = await unveil!.arbiter.openEvidence(r.id);
                    setEvidence({ id: r.id, url: URL.createObjectURL(new Blob([new Uint8Array(img)])) });
                  }}
                />
                <ActionButton
                  label="Leak proven: pay anon"
                  busyLabel="Resolving…"
                  className="danger"
                  onClick={async () => {
                    await unveil!.arbiter.resolve(r.id, true);
                    toast('Deposit paid to anon', 'ok');
                    refresh();
                  }}
                />
                <ActionButton
                  label="Not proven: refund"
                  busyLabel="Resolving…"
                  onClick={async () => {
                    await unveil!.arbiter.resolve(r.id, false);
                    toast('Deposit refunded', 'ok');
                    refresh();
                  }}
                />
              </div>
            </article>
          ))
        )}
      </div>
      <EvidenceDialog evidence={evidence} onClose={() => setEvidence(null)} />
    </section>
  );
}

function EvidenceDialog({ evidence, onClose }: { evidence: { id: number; url: string } | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!evidence) return;
    dialog.showModal();
    return () => {
      URL.revokeObjectURL(evidence.url);
      if (dialog.open) dialog.close();
    };
  }, [evidence]);

  return (
    <dialog ref={ref} className="wide" onClose={onClose}>
      <header>
        <h2>{evidence ? `Evidence for #${evidence.id}` : 'Evidence'}</h2>
        <button type="button" aria-label="Close" onClick={() => ref.current?.close()}>
          ✕
        </button>
      </header>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {evidence && <img id="evidence-img" src={evidence.url} alt="Leaked image submitted as evidence" />}
      <p className="tiny muted">
        Check the watermark: it names the viewer&apos;s wallet and the reveal number. The file&apos;s hash matches the one the anon put on-chain.
      </p>
    </dialog>
  );
}
