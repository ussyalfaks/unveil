'use client';

import { useEffect, useRef, useState } from 'react';
import { crypto as C, ndaRecipient } from 'unveil-sdk';
import { capturePhoto, startCamera, stopCamera, type CapturedPhoto } from 'unveil-sdk/browser';
import { EXPLORER } from '@/lib/config';
import { ago, fmtAmt, short, when } from '@/lib/format';
import { ActionButton, CopyButton, StatusPill, pickFile, useLoad } from './ui';
import { useUnveil } from './UnveilProvider';

const MAX_EVIDENCE = 2.9 * 1024 * 1024; // storage takes 3 MB; leave room for encryption overhead

export function AnonPanel() {
  return (
    <section className="panel">
      <div className="grid">
        <CameraBox />
        <ProfileBox />
      </div>
      <h2 className="section-title">Requests to see you</h2>
      <Inbox />
    </section>
  );
}

function CameraBox() {
  const { unveil, address, toast, refresh } = useUnveil();
  const videoRef = useRef<HTMLVideoElement>(null);
  const shotRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [live, setLive] = useState(false);
  const [snapped, setSnapped] = useState<CapturedPhoto | null>(null);
  const [realName, setRealName] = useState('');

  const stop = () => {
    stopCamera(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
  };

  useEffect(() => stop, []); // release the camera when leaving the tab

  const start = async () => {
    try {
      stop(); // don't leak a previous stream if started twice
      const stream = await startCamera();
      streamRef.current = stream;
      videoRef.current!.srcObject = stream;
      setSnapped(null);
      setLive(true);
    } catch (e) {
      toast('Camera blocked: ' + (e as Error).message, 'error');
    }
  };

  const snap = async () => {
    if (!address) return toast('Connect your wallet first so the photo can be stamped with it', 'error');
    const shot = await capturePhoto(videoRef.current!, address, { preview: shotRef.current! });
    stop();
    setSnapped(shot);
  };

  return (
    <div className="box">
      <h2>Your live photo</h2>
      <p className="muted">
        Taken now, stamped with your wallet and the time, then encrypted before it leaves this page. The server stores only
        ciphertext; Stellar stores only its hash.
      </p>
      <div className="camera">
        <video ref={videoRef} autoPlay playsInline muted hidden={!live} />
        <canvas ref={shotRef} hidden={live || !snapped} />
        <div className="cam-empty">camera off</div>
      </div>
      <label>
        Real name (optional, shown only to requesters you approve)
        <input
          value={realName}
          onChange={(e) => setRealName(e.target.value)}
          maxLength={C.MAX_NAME}
          autoComplete="off"
          placeholder="Leave empty to reveal your photo only"
        />
      </label>
      <div className="actions">
        {live ? (
          <button type="button" className="danger" onClick={stop}>
            Stop camera
          </button>
        ) : (
          <button type="button" onClick={start}>
            Start camera
          </button>
        )}
        <button type="button" disabled={!live} onClick={snap}>
          Take photo
        </button>
        <ActionButton
          label="Encrypt & register"
          className="primary"
          disabled={!snapped || !unveil}
          onClick={async () => {
            if (!address) throw new Error('Connect your wallet first');
            const { hash } = await unveil!.anon.register({ photo: snapped!.bytes, capturedAt: snapped!.capturedAt, realName });
            toast('Profile registered on Stellar ✓', 'ok');
            setSnapped(null);
            sessionStorage.setItem('unveil:lastTx', hash ?? '');
            refresh();
          }}
        />
      </div>
    </div>
  );
}

function ProfileBox() {
  const { unveil, address, version } = useUnveil();
  const { data: profile, loading } = useLoad(() => (unveil && address ? unveil.profile(address) : null), [unveil, address, version]);
  const lastTx = typeof window !== 'undefined' ? sessionStorage.getItem('unveil:lastTx') : null;

  return (
    <div className="box">
      <h2>Your profile</h2>
      {!address ? (
        <p className="muted">Connect your wallet to see your profile.</p>
      ) : loading && !profile ? (
        <p className="muted">Loading…</p>
      ) : !profile ? (
        <p className="muted">No profile yet. Take a photo and register to start receiving requests.</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Photo commitment</dt>
            <dd className="mono">{C.toHex(profile.photoHash).slice(0, 24)}…</dd>
            <dt>Taken</dt>
            <dd>{when(profile.capturedAt)}</dd>
            <dt>Freshness</dt>
            <dd>registered {profile.registeredAt - profile.capturedAt}s after capture</dd>
            <dt>Your anon address</dt>
            <dd className="addr-row">
              <span className="mono">{address}</span>
              <CopyButton text={address} />
            </dd>
          </dl>
          {lastTx && (
            <a className="link" target="_blank" rel="noopener" href={`${EXPLORER}/tx/${lastTx}`}>
              View transaction ↗
            </a>
          )}
        </>
      )}
    </div>
  );
}

function Inbox() {
  const { unveil, address, cfg, version, toast, refresh } = useUnveil();
  const { data } = useLoad(
    () =>
      unveil && address
        ? unveil.requests({ anon: address }).then((rs) =>
            Promise.all(
              rs.map(async (r) => {
                const [nda, p] = await Promise.all([unveil.ndaText(r), unveil.platforms.get(r.platform)]);
                // Evidence is sealed to the request's own arbiter, who must still hold the platform's key.
                return { r, nda, canSeal: p.arbiter === r.arbiter && p.arbiterKey.length > 0 };
              }),
            ),
          )
        : null,
    [unveil, address, version],
  );

  if (!address) return <div className="cards"><p className="muted">Connect your wallet to see requests.</p></div>;
  if (!data) return <div className="cards"><p className="muted">Loading…</p></div>;
  if (!data.length)
    return (
      <div className="cards">
        <p className="muted">No one has asked yet. Share your anon address with the team that wants to vet you.</p>
      </div>
    );

  const now = Date.now() / 1000;
  return (
    <div className="cards">
      {data.map(({ r, nda, canSeal }) => {
        const watchEnd = r.revealedAt + (cfg?.watchSecs ?? 0);
        const canReport = r.status === 'Revealed' && now < watchEnd;
        const noKey = !canSeal;
        return (
          <article key={r.id} className="card">
            <header>
              <span className="mono">#{r.id}</span>
              <StatusPill status={r.status} />
            </header>
            <p>
              <strong>{ndaRecipient(nda)}</strong>{' '}
              <span className="mono muted">{short(r.requester)}</span> wants to see who you are.
            </p>
            <dl className="facts">
              <dt>Deposit at stake</dt>
              <dd>{fmtAmt(r.deposit)}</dd>
              <dt>Asked</dt>
              <dd>{ago(r.createdAt)}</dd>
              {r.status === 'Revealed' && (
                <>
                  <dt>Leak window closes</dt>
                  <dd>{when(watchEnd)}</dd>
                </>
              )}
            </dl>
            <details>
              <summary>NDA they signed</summary>
              {nda ? <pre>{nda}</pre> : <p className="warn">NDA text not found. The hash on-chain is all there is. Be careful approving.</p>}
              <p className="mono tiny">sha256 {C.toHex(r.ndaHash)}</p>
            </details>
            <div className="actions">
              {r.status === 'Pending' && (
                <>
                  <ActionButton
                    label="Approve & reveal"
                    busyLabel="Revealing…"
                    className="primary"
                    onClick={async () => {
                      await unveil!.anon.approve(r.id);
                      toast(`Revealed to ${short(r.requester)}. Their deposit is now locked.`, 'ok');
                      refresh();
                    }}
                  />
                  <ActionButton
                    label="Decline"
                    busyLabel="Declining…"
                    onClick={async () => {
                      await unveil!.anon.decline(r.id);
                      toast('Declined, deposit refunded to them', 'ok');
                      refresh();
                    }}
                  />
                </>
              )}
              {canReport && (
                <ActionButton
                  label="Report a leak"
                  busyLabel="Reporting…"
                  className="danger"
                  disabled={noKey}
                  onClick={async () => {
                    const file = await pickFile('image/*');
                    if (!file) return;
                    if (file.size > MAX_EVIDENCE) throw new Error('Image is too large (max 2.9 MB). Crop or compress it.');
                    await unveil!.anon.reportLeak(r.id, new Uint8Array(await file.arrayBuffer()));
                    toast('Leak reported. The deposit is frozen until the arbiter decides.', 'ok');
                    refresh();
                  }}
                />
              )}
            </div>
            {canReport && noKey && (
              <p className="warn tiny">
                This request&apos;s arbiter hasn&apos;t set up an evidence key, so leak reports can&apos;t be encrypted yet. Ask them to open the Arbiter tab.
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}
