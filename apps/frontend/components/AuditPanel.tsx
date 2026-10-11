'use client';

import { crypto as C } from 'unveil-sdk';
import { CONTRACT_ID, EXPLORER } from '@/lib/config';
import { fmtAmt, short, when } from '@/lib/format';
import { StatusPill, useLoad } from './ui';
import { useUnveil } from './UnveilProvider';

export function AuditPanel() {
  const { unveil, version } = useUnveil();
  const { data } = useLoad(() => (unveil ? unveil.requests() : null), [unveil, version]);

  return (
    <section className="panel">
      <div className="box">
        <h2>Everything, on-chain</h2>
        <p className="muted">
          Every request, NDA hash, reveal and dispute is recorded by the{' '}
          <a className="link" target="_blank" rel="noopener" href={`${EXPLORER}/contract/${CONTRACT_ID}`}>
            Unveil contract ↗
          </a>
          . No names, no photos: just who asked whom, under which agreement, and when.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Requester</th>
                <th>Anon</th>
                <th>Deposit</th>
                <th>NDA hash</th>
                <th>Asked</th>
                <th>Revealed</th>
              </tr>
            </thead>
            <tbody>
              {!data ? (
                <tr>
                  <td colSpan={8} className="muted">
                    Loading…
                  </td>
                </tr>
              ) : !data.length ? (
                <tr>
                  <td colSpan={8} className="muted">
                    Nothing on-chain yet.
                  </td>
                </tr>
              ) : (
                data.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">#{r.id}</td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td className="mono">{short(r.requester)}</td>
                    <td className="mono">{short(r.anon)}</td>
                    <td>{fmtAmt(r.deposit)}</td>
                    <td className="mono">{C.toHex(r.ndaHash).slice(0, 12)}…</td>
                    <td>{when(r.createdAt)}</td>
                    <td>{when(r.revealedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
