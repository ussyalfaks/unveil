'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildNda, crypto as C, fromUnits, ndaRecipient, toUnits, type Profile, type RevealRequest } from '@unveil/sdk';
import { openPeephole } from '@unveil/sdk/browser';
import { TOKEN_SYMBOL } from '@/lib/config';
import { ago, fmtAmt, period, short, when } from '@/lib/format';
import { ActionButton, StatusPill, downloadText, useLoad } from './ui';
import { useUnveil } from './UnveilProvider';

const enc = new TextEncoder();

interface OpenReveal {
  request: RevealRequest;
  jpeg: Uint8Array;
  realName: string;
  watermark: string[];
}

export function RequesterPanel() {
  const { unveil, address, cfg, toast, refresh } = useUnveil();
  const [anon, setAnon] = useState('');
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined); // undefined = not looked up
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [purpose, setPurpose] = useState('');
  const [deposit, setDeposit] = useState('');
  const [agree, setAgree] = useState(false);
  const [reveal, setReveal] = useState<OpenReveal | null>(null);

  const minDeposit = cfg ? fromUnits(cfg.minDeposit) : 0;
  useEffect(() => {
    if (cfg && !deposit) setDeposit(String(minDeposit));
  }, [cfg, deposit, minDeposit]);

  const nda = useMemo(
    () =>
      buildNda({
        recipient: name,
        organisation: org,
        recipientWallet: address ?? '',
        discloserWallet: anon.trim(),
        purpose,
        deposit,
        tokenSymbol: TOKEN_SYMBOL,
        watchSecs: cfg?.watchSecs,
      }),
    [name, org, address, anon, purpose, deposit, cfg],
  );
  const ndaHash = useMemo(() => C.toHex(C.sha256Bytes(enc.encode(nda))), [nda]);

  return (
    <section className="panel">
      <div className="grid">
        <div className="box">
          <h2>Who do you want to vet?</h2>
          <label>
            Anon&apos;s Stellar address
            <span className="row">
              <input
                value={anon}
                onChange={(e) => {
                  setAnon(e.target.value);
                  setProfile(undefined);
                }}
                placeholder="G…"
                autoComplete="off"
                spellCheck={false}
              />
              <ActionButton
                label="Look up"
                busyLabel="Looking…"
                disabled={!unveil}
                onClick={async () => {
                  const a = anon.trim();
                  if (!/^G[A-Z2-7]{55}$/.test(a)) throw new Error('That is not a Stellar address (starts with G, 56 characters)');
                  setProfile(await unveil!.profile(a));
                }}
              />
            </span>
          </label>
          {profile === null && <p className="warn">This address has no Unveil profile yet.</p>}
          {profile && (
            <>
              <p className="ok-line">✓ Live photo on file</p>
              <dl className="facts">
                <dt>Taken</dt>
                <dd>
                  {when(profile.capturedAt)} ({ago(profile.capturedAt)})
                </dd>
                <dt>Freshness</dt>
                <dd>reached the chain {profile.registeredAt - profile.capturedAt}s after capture</dd>
              </dl>
              <div id="request-form">
                <label>
                  Your name (on the NDA and every watermark)
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label>
                  Organisation
                  <input value={org} onChange={(e) => setOrg(e.target.value)} />
                </label>
                <label>
                  Purpose
                  <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. vetting before treasury signer role" />
                </label>
                <label>
                  Deposit ({TOKEN_SYMBOL}, locked for {cfg ? period(cfg.watchSecs) : '?'} after reveal)
                  <input type="number" step="1" min={minDeposit} value={deposit} onChange={(e) => setDeposit(e.target.value)} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I accept this NDA. My Stellar
                  signature is my signature.
                </label>
                <ActionButton
                  label="Sign NDA & lock deposit"
                  className="primary"
                  onClick={async () => {
                    if (!address) throw new Error('Connect your wallet first');
                    if (!name.trim()) throw new Error('Your name goes on the NDA and on the watermark. Fill it in.');
                    if (!agree) throw new Error('Tick the box to accept the NDA');
                    const units = toUnits(deposit || '0');
                    if (cfg && units < cfg.minDeposit) throw new Error(`Minimum deposit is ${fmtAmt(cfg.minDeposit)}`);
                    const { result: id } = await unveil!.requester.request({ anon: anon.trim(), ndaText: nda, deposit: units });
                    toast(`Request #${id} sent. You'll see the result below once they answer.`, 'ok');
                    downloadText(`unveil-nda-${id}.txt`, nda);
                    refresh();
                  }}
                />
              </div>
            </>
          )}
        </div>
        <div className="box nda">
          <h2>The NDA you&apos;re signing</h2>
          <pre>{nda}</pre>
          <p className="tiny mono">sha256 {ndaHash}</p>
          <p className="muted tiny">This hash goes on-chain inside the transaction you sign. Change one character and the hash changes.</p>
        </div>
      </div>
      <h2 className="section-title">Your requests</h2>
      <Outbox onOpen={setReveal} />
      <RevealDialog reveal={reveal} onClose={() => setReveal(null)} />
    </section>
  );
}

function Outbox({ onOpen }: { onOpen: (r: OpenReveal) => void }) {
  const { unveil, address, cfg, version, toast, refresh } = useUnveil();
  const { data } = useLoad(() => (unveil && address ? unveil.requests({ requester: address }) : null), [unveil, address, version]);

  if (!address) return <div className="cards"><p className="muted">Connect your wallet to see your requests.</p></div>;
  if (!data) return <div className="cards"><p className="muted">Loading…</p></div>;
  if (!data.length) return <div className="cards"><p className="muted">No requests yet.</p></div>;

  const now = Date.now() / 1000;
  return (
    <div className="cards">
      {data.map((r) => {
        const unlock = r.revealedAt + (cfg?.watchSecs ?? 0);
        return (
          <article key={r.id} className="card">
            <header>
              <span className="mono">#{r.id}</span>
              <StatusPill status={r.status} />
            </header>
            <p>
              Anon <span className="mono">{short(r.anon)}</span> · deposit {fmtAmt(r.deposit)}
            </p>
            {r.status === 'Revealed' && <p className="muted">Deposit unlocks {when(unlock)}</p>}
            <div className="actions">
              {r.status === 'Pending' && (
                <ActionButton
                  label="Cancel & refund"
                  busyLabel="Cancelling…"
                  onClick={async () => {
                    await unveil!.requester.cancel(r.id);
                    toast('Cancelled, deposit refunded', 'ok');
                    refresh();
                  }}
                />
              )}
              {r.status === 'Revealed' && (
                <ActionButton
                  label="View identity"
                  busyLabel="Decrypting…"
                  className="primary"
                  onClick={async () => {
                    const opened = await unveil!.requester.open(r.id);
                    onOpen({
                      request: r,
                      jpeg: opened.jpeg,
                      realName: opened.name,
                      watermark: [ndaRecipient(opened.ndaText), `${short(address)} · #${r.id}`, `${new Date().toISOString().slice(0, 16)}Z`],
                    });
                  }}
                />
              )}
              {r.status === 'Revealed' && now >= unlock && (
                <ActionButton
                  label="Withdraw deposit"
                  busyLabel="Withdrawing…"
                  onClick={async () => {
                    await unveil!.requester.release(r.id);
                    toast('Deposit returned ✓', 'ok');
                    refresh();
                  }}
                />
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function RevealDialog({ reveal, onClose }: { reveal: OpenReveal | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const peepRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current!;
    if (!reveal) return;
    dialog.showModal();
    let close: (() => void) | null = null;
    let cancelled = false;
    openPeephole(peepRef.current!, reveal.jpeg, { watermark: reveal.watermark }).then((c) => {
      if (cancelled) c();
      else close = c;
    });
    return () => {
      cancelled = true;
      close?.();
      if (dialog.open) dialog.close();
    };
  }, [reveal]);

  return (
    <dialog ref={dialogRef} onClose={onClose}>
      <header>
        <h2>{reveal ? `Reveal #${reveal.request.id} · anon ${short(reveal.request.anon)}` : 'Reveal'}</h2>
        <button type="button" aria-label="Close" onClick={() => dialogRef.current?.close()}>
          ✕
        </button>
      </header>
      {reveal && (
        <p className={`reveal-name${reveal.realName ? '' : ' none'}`}>
          {reveal.realName ? `Real name: ${reveal.realName}` : 'No real name shared, photo only.'}
        </p>
      )}
      <div id="peephole" ref={peepRef} />
      <p className="tiny muted">
        You see one small circle at a time, stamped with your name and wallet. Closing this window or switching tabs hides it.
      </p>
    </dialog>
  );
}
