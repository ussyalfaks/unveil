import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import './style.css';
import { CONFIG } from './config.js';
import { connect, me, api, signMessage, uploadBlob, downloadBlob } from './chain.js';
import * as C from './crypto.js';
import { openPeephole } from './peephole.js';

const $ = (s, el = document) => el.querySelector(s);
const enc = new TextEncoder();
const dec = new TextDecoder();
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const fmtAmt = (v) => (Number(v) / 10 ** CONFIG.TOKEN_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ' + CONFIG.TOKEN_SYMBOL;
const toUnits = (n) => BigInt(Math.round(Number(n) * 10 ** CONFIG.TOKEN_DECIMALS));
const when = (s) => (s ? new Date(s * 1000).toLocaleString() : '—');
const ago = (s) => {
  const d = Math.max(0, Date.now() / 1000 - s);
  if (d < 90) return `${Math.round(d)}s ago`;
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 129600) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let cfg = null;

// ---------- feedback ----------
function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 5000);
}

async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- tabs ----------
document.querySelectorAll('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== b.dataset.tab));
    if (b.dataset.tab === 'audit') renderAudit();
  }),
);

// ---------- wallet ----------
$('#connect').addEventListener('click', (e) =>
  busy(e.target, 'Connecting…', async () => {
    const a = await connect();
    $('#connect').textContent = short(a);
    $('#connect').classList.add('connected');
    document.body.classList.add('has-wallet');
    await refreshAll();
  }),
);

async function refreshAll() {
  try {
    cfg = await api.config();
    $('#deposit').value = Number(cfg.min_deposit) / 10 ** CONFIG.TOKEN_DECIMALS;
    $('#deposit').min = $('#deposit').value;
    $('#watch-days').textContent = Math.round(cfg.watch_secs / 86400);
    $('#arbiter-tab').hidden = me() !== cfg.admin;
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  await Promise.all([renderMyProfile(), renderInbox(), renderOutbox(), renderArbiter()]);
}

// ======================================================
// ANON: live photo → encrypt → register
// ======================================================
let stream = null;
let snapped = null; // { bytes, capturedAt }

$('#cam-start').addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 640 }, audio: false });
    $('#cam').srcObject = stream;
    $('#cam').hidden = false;
    $('#shot').hidden = true;
    $('#cam-snap').disabled = false;
    $('#register').disabled = true;
  } catch (e) {
    toast('Camera blocked: ' + e.message, 'error');
  }
});

$('#cam-snap').addEventListener('click', async () => {
  if (!me()) return toast('Connect your wallet first so the photo can be stamped with it', 'error');
  const v = $('#cam');
  const s = Math.min(v.videoWidth, v.videoHeight);
  const cv = $('#shot');
  cv.width = cv.height = 480;
  const ctx = cv.getContext('2d');
  ctx.translate(480, 0);
  ctx.scale(-1, 1); // mirror like a selfie
  ctx.drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, 0, 0, 480, 480);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Burn the wallet + time into the pixels: proves this photo was taken for this wallet, now.
  const capturedAt = Math.floor(Date.now() / 1000);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 446, 480, 34);
  ctx.fillStyle = '#fff';
  ctx.font = '600 12px "JetBrains Mono", monospace';
  ctx.fillText(`UNVEIL · ${short(me())} · ${new Date(capturedAt * 1000).toISOString().replace('T', ' ').slice(0, 19)}Z`, 12, 468);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
  snapped = { bytes: new Uint8Array(await blob.arrayBuffer()), capturedAt };
  stream?.getTracks().forEach((t) => t.stop());
  v.hidden = true;
  cv.hidden = false;
  $('#cam-snap').disabled = true;
  $('#register').disabled = false;
});

$('#register').addEventListener('click', (e) =>
  busy(e.target, 'Working…', async () => {
    if (!snapped) throw new Error('Take a photo first');
    // Only a live, recent capture counts.
    if (Date.now() / 1000 - snapped.capturedAt > 600) throw new Error('Photo is older than 10 minutes. Take a fresh one.');
    toast('Sign the message in Freighter to derive your photo key (no funds move).');
    const K = C.photoKeyFromSignature(await signMessage(C.PHOTO_KEY_MESSAGE(me())));
    const sealed = await C.encryptPhoto(K, snapped.bytes);
    const hex = await uploadBlob(sealed);
    if (hex !== C.toHex(C.sha256Bytes(sealed))) throw new Error('Server returned the wrong hash');
    toast('Encrypted photo stored. Now confirm the Stellar transaction.');
    const { hash } = await api.setProfile(C.sha256Bytes(sealed), snapped.capturedAt);
    toast('Profile registered on Stellar ✓', 'ok');
    snapped = null;
    $('#register').disabled = true;
    await renderMyProfile(hash);
  }),
);

async function renderMyProfile(txHash) {
  const el = $('#my-profile');
  const p = me() ? await api.getProfile(me()) : null;
  if (!p) {
    el.innerHTML = `<p class="muted">No profile yet. Take a photo and register to start receiving requests.</p>`;
    return;
  }
  el.innerHTML = `
    <dl class="facts">
      <dt>Photo commitment</dt><dd class="mono">${C.toHex(p.photo_hash).slice(0, 24)}…</dd>
      <dt>Taken</dt><dd>${when(p.captured_at)}</dd>
      <dt>Freshness</dt><dd>registered ${p.registered_at - p.captured_at}s after capture</dd>
      <dt>Your anon address</dt><dd class="mono copy" title="Click to copy">${me()}</dd>
    </dl>
    ${txHash ? `<a class="link" target="_blank" rel="noopener" href="${CONFIG.EXPLORER}/tx/${txHash}">View transaction ↗</a>` : ''}`;
  $('.copy', el).addEventListener('click', () => navigator.clipboard.writeText(me()).then(() => toast('Address copied', 'ok')));
}

// ---------- NDA helpers ----------
async function fetchNda(hashBytes) {
  try {
    return dec.decode(await downloadBlob(C.toHex(hashBytes)));
  } catch {
    return null;
  }
}
const ndaName = (text) => (text?.match(/^Recipient: (.+)$/m) || [])[1] || 'unknown recipient';

function statusPill(s) {
  return `<span class="pill s-${s.toLowerCase()}">${s}</span>`;
}

// ---------- ANON inbox ----------
async function renderInbox() {
  const el = $('#inbox');
  if (!me()) return;
  const all = (await api.allRequests()).filter((r) => r.anon === me());
  if (!all.length) {
    el.innerHTML = `<p class="muted">No one has asked yet. Share your anon address with the team that wants to vet you.</p>`;
    return;
  }
  el.innerHTML = '';
  for (const r of all) {
    const nda = await fetchNda(r.nda_hash);
    const watchEnd = r.revealed_at + cfg.watch_secs;
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <header><span class="mono">#${r.id}</span>${statusPill(r.status)}</header>
      <p><strong>${esc(ndaName(nda))}</strong> <span class="mono muted">${short(r.requester)}</span> wants to see who you are.</p>
      <dl class="facts">
        <dt>Deposit at stake</dt><dd>${fmtAmt(r.deposit)}</dd>
        <dt>Asked</dt><dd>${ago(r.created_at)}</dd>
        ${r.status === 'Revealed' ? `<dt>Leak window closes</dt><dd>${when(watchEnd)}</dd>` : ''}
      </dl>
      <details><summary>NDA they signed</summary>${nda ? `<pre>${esc(nda)}</pre>` : '<p class="warn">NDA text not found. The hash on-chain is all there is. Be careful approving.</p>'}<p class="mono tiny">sha256 ${C.toHex(r.nda_hash)}</p></details>
      <div class="actions"></div>`;
    const actions = $('.actions', card);
    if (r.status === 'Pending') {
      actions.append(
        button('Approve & reveal', 'primary', (b) =>
          busy(b, 'Revealing…', async () => {
            toast('Sign to re-derive your photo key (no funds move).');
            const K = C.photoKeyFromSignature(await signMessage(C.PHOTO_KEY_MESSAGE(me())));
            const wrapped = await C.wrapKey(K, r.requester_key);
            await api.approve(r.id, wrapped);
            toast(`Revealed to ${short(r.requester)}. Their deposit is now locked.`, 'ok');
            renderInbox();
          }),
        ),
        button('Decline', '', (b) => busy(b, 'Declining…', async () => { await api.decline(r.id); toast('Declined, deposit refunded to them', 'ok'); renderInbox(); })),
      );
    }
    if (r.status === 'Revealed' && Date.now() / 1000 < watchEnd) {
      actions.append(
        button('Report a leak', 'danger', (b) =>
          busy(b, 'Reporting…', async () => {
            const ev = prompt('Paste a link to, or a description of, the leaked image. Its hash goes on-chain as evidence; keep the original to show the arbiter.');
            if (!ev) return;
            await api.reportLeak(r.id, C.sha256Bytes(enc.encode(ev)));
            toast('Leak reported. The deposit is frozen until the arbiter decides.', 'ok');
            renderInbox();
          }),
        ),
      );
    }
    el.append(card);
  }
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', () => onClick(b));
  return b;
}

// ======================================================
// REQUESTER: lookup → NDA → deposit → view
// ======================================================
function ndaText() {
  const days = cfg ? `${Math.round(cfg.watch_secs / 86400)} days` : '[watch period]';
  return `UNVEIL CONFIDENTIALITY AGREEMENT v1

Recipient: ${$('#nda-name').value.trim() || '[your name]'}
Organisation: ${$('#nda-org').value.trim() || '[organisation]'}
Recipient wallet: ${me() || '[connect wallet]'}
Discloser wallet: ${$('#anon-addr').value.trim() || '[anon address]'}
Purpose: ${$('#nda-purpose').value.trim() || '[purpose]'}

1. The Recipient will view the Discloser's photo only for the Purpose above.
2. The Recipient will not copy, screenshot, record, store or share the photo, and will not describe the Discloser's appearance or identity to anyone.
3. The Recipient accepts that every view is watermarked with their name and wallet, and that a deposit of ${$('#deposit').value || '[amount]'} ${CONFIG.TOKEN_SYMBOL} is locked on Stellar for ${days} after the reveal and paid to the Discloser if a leak is proven.
4. Signing the Stellar transaction that carries this agreement's SHA-256 hash is the Recipient's signature.`;
}

function updateNda() {
  const t = ndaText();
  $('#nda-preview').textContent = t;
  $('#nda-hash').textContent = C.toHex(C.sha256Bytes(enc.encode(t)));
}
['#nda-name', '#nda-org', '#nda-purpose', '#anon-addr', '#deposit'].forEach((s) => $(s).addEventListener('input', updateNda));
updateNda();

$('#lookup').addEventListener('click', (e) =>
  busy(e.target, 'Looking…', async () => {
    const a = $('#anon-addr').value.trim();
    if (!/^G[A-Z2-7]{55}$/.test(a)) throw new Error('That is not a Stellar address (starts with G, 56 characters)');
    const p = await api.getProfile(a);
    $('#anon-card').innerHTML = p
      ? `<p class="ok-line">✓ Live photo on file</p>
         <dl class="facts">
           <dt>Taken</dt><dd>${when(p.captured_at)} (${ago(p.captured_at)})</dd>
           <dt>Freshness</dt><dd>reached the chain ${p.registered_at - p.captured_at}s after capture</dd>
         </dl>`
      : `<p class="warn">This address has no Unveil profile yet.</p>`;
    $('#request-form').hidden = !p;
    updateNda();
  }),
);

$('#send-request').addEventListener('click', (e) =>
  busy(e.target, 'Working…', async () => {
    if (!me()) throw new Error('Connect your wallet first');
    if (!$('#nda-name').value.trim()) throw new Error('Your name goes on the NDA and on the watermark. Fill it in.');
    if (!$('#nda-agree').checked) throw new Error('Tick the box to accept the NDA');
    const deposit = toUnits($('#deposit').value);
    if (deposit < cfg.min_deposit) throw new Error(`Minimum deposit is ${fmtAmt(cfg.min_deposit)}`);
    updateNda();
    const text = ndaText();
    const textBytes = enc.encode(text);
    await uploadBlob(textBytes); // so the anon can read exactly what was signed
    toast('Sign to derive your viewing key (no funds move).');
    const secret = C.requesterSecretFromSignature(await signMessage(C.REQUESTER_KEY_MESSAGE(me())));
    toast('Now confirm the transaction: it signs the NDA and locks the deposit.');
    const { result } = await api.requestReveal($('#anon-addr').value.trim(), C.sha256Bytes(textBytes), C.publicKeyOf(secret), deposit);
    toast(`Request #${result} sent. You'll see the result below once they answer.`, 'ok');
    downloadText(`unveil-nda-${result}.txt`, text);
    renderOutbox();
  }),
);

function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function renderOutbox() {
  const el = $('#outbox');
  if (!me()) return;
  const mine = (await api.allRequests()).filter((r) => r.requester === me());
  if (!mine.length) {
    el.innerHTML = `<p class="muted">No requests yet.</p>`;
    return;
  }
  el.innerHTML = '';
  for (const r of mine) {
    const unlock = r.revealed_at + cfg.watch_secs;
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <header><span class="mono">#${r.id}</span>${statusPill(r.status)}</header>
      <p>Anon <span class="mono">${short(r.anon)}</span> · deposit ${fmtAmt(r.deposit)}</p>
      ${r.status === 'Revealed' ? `<p class="muted">Deposit unlocks ${when(unlock)}</p>` : ''}
      <div class="actions"></div>`;
    const actions = $('.actions', card);
    if (r.status === 'Pending') actions.append(button('Cancel & refund', '', (b) => busy(b, 'Cancelling…', async () => { await api.cancel(r.id); toast('Cancelled, deposit refunded', 'ok'); renderOutbox(); })));
    if (r.status === 'Revealed') {
      actions.append(button('View identity', 'primary', (b) => busy(b, 'Decrypting…', () => view(r))));
      if (Date.now() / 1000 >= unlock) actions.append(button('Withdraw deposit', '', (b) => busy(b, 'Withdrawing…', async () => { await api.release(r.id); toast('Deposit returned ✓', 'ok'); renderOutbox(); })));
    }
    el.append(card);
  }
}

let closePeep = null;
async function view(r) {
  toast('Sign to derive your viewing key (no funds move).');
  const secret = C.requesterSecretFromSignature(await signMessage(C.REQUESTER_KEY_MESSAGE(me())));
  const K = await C.unwrapKey(r.wrapped_key, secret);
  const profile = await api.getProfile(r.anon);
  const sealed = await downloadBlob(C.toHex(profile.photo_hash));
  if (C.toHex(C.sha256Bytes(sealed)) !== C.toHex(profile.photo_hash)) throw new Error('Photo does not match the on-chain commitment');
  const jpeg = await C.decryptPhoto(K, sealed);
  const name = ndaName(await fetchNda(r.nda_hash));
  const stamp = `${name}\n${short(me())} · #${r.id}\n${new Date().toISOString().slice(0, 16)}Z`;
  $('#modal-title').textContent = `Reveal #${r.id} · anon ${short(r.anon)}`;
  $('#modal').showModal();
  closePeep = await openPeephole($('#peephole'), jpeg, stamp);
}
$('#modal-close').addEventListener('click', () => $('#modal').close());
$('#modal').addEventListener('close', () => { closePeep?.(); closePeep = null; });

// ======================================================
// ARBITER + AUDIT
// ======================================================
async function renderArbiter() {
  const el = $('#disputes');
  if (!cfg || me() !== cfg.admin) return;
  const open = (await api.allRequests()).filter((r) => r.status === 'Disputed');
  el.innerHTML = open.length ? '' : '<p class="muted">No open disputes.</p>';
  for (const r of open) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <header><span class="mono">#${r.id}</span>${statusPill(r.status)}</header>
      <p>Anon <span class="mono">${short(r.anon)}</span> says <span class="mono">${short(r.requester)}</span> leaked. Deposit ${fmtAmt(r.deposit)}.</p>
      <p class="mono tiny">evidence sha256 ${C.toHex(r.evidence_hash)}</p>
      <p class="muted">Check the leaked image's watermark: it names the viewer's wallet and reveal number.</p>
      <div class="actions"></div>`;
    $('.actions', card).append(
      button('Leak proven: pay anon', 'danger', (b) => busy(b, 'Resolving…', async () => { await api.resolve(r.id, true); toast('Deposit paid to anon', 'ok'); renderArbiter(); })),
      button('Not proven: refund', '', (b) => busy(b, 'Resolving…', async () => { await api.resolve(r.id, false); toast('Deposit refunded', 'ok'); renderArbiter(); })),
    );
    el.append(card);
  }
}

async function renderAudit() {
  const el = $('#audit-rows');
  try {
    const all = await api.allRequests();
    el.innerHTML = all.length
      ? all
          .map(
            (r) => `<tr>
          <td class="mono">#${r.id}</td>
          <td>${statusPill(r.status)}</td>
          <td class="mono">${short(r.requester)}</td>
          <td class="mono">${short(r.anon)}</td>
          <td>${fmtAmt(r.deposit)}</td>
          <td class="mono">${C.toHex(r.nda_hash).slice(0, 12)}…</td>
          <td>${when(r.created_at)}</td>
          <td>${when(r.revealed_at)}</td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="8" class="muted">Nothing on-chain yet.</td></tr>';
    $('#contract-link').href = `${CONFIG.EXPLORER}/contract/${CONFIG.CONTRACT_ID}`;
  } catch (e) {
    el.innerHTML = `<tr><td colspan="8" class="warn">${esc(e.message)}</td></tr>`;
  }
}

$('#token-sym').textContent = CONFIG.TOKEN_SYMBOL;
if (!CONFIG.CONTRACT_ID) toast('No contract set yet. Deploy it and set VITE_CONTRACT_ID (see README).', 'error');
