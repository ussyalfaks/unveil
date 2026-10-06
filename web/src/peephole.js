// Shows a decrypted photo one small circle at a time, under the cursor.
// Every visible pixel carries the viewer's watermark, so stitched
// screenshots still name whoever leaked them.
//
// Honest limit: the decrypted image lives in this tab's memory. A determined
// viewer with dev tools can pull it out. The peephole raises the effort and
// the watermark + on-chain deposit raise the cost; neither makes it impossible.

const RADIUS = 58;

export async function openPeephole(container, jpegBytes, watermark) {
  const bmp = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }));
  const size = Math.min(container.clientWidth || 420, 420);

  const view = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  view.width = size * dpr;
  view.height = size * dpr;
  view.style.width = size + 'px';
  view.style.height = size + 'px';
  view.className = 'peephole-canvas';
  view.setAttribute('aria-label', 'Hidden photo. Move your pointer over it to reveal one small area at a time.');
  container.replaceChildren(view);

  const ctx = view.getContext('2d');
  ctx.scale(dpr, dpr);

  // Pre-render a watermark tile once.
  const tile = document.createElement('canvas');
  tile.width = 170;
  tile.height = 64;
  const t = tile.getContext('2d');
  t.translate(85, 32);
  t.rotate(-0.35);
  t.font = '600 9px "JetBrains Mono", monospace';
  t.textAlign = 'center';
  t.fillStyle = 'rgba(255,255,255,0.45)';
  t.strokeStyle = 'rgba(0,0,0,0.45)';
  t.lineWidth = 2;
  watermark.split('\n').forEach((line, i, arr) => {
    const y = (i - (arr.length - 1) / 2) * 11;
    t.strokeText(line, 0, y);
    t.fillText(line, 0, y);
  });
  const pattern = ctx.createPattern(tile, 'repeat');

  function blank() {
    ctx.fillStyle = '#121110';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#2a2724';
    ctx.font = '500 13px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('move over the frame to peek', size / 2, size / 2);
  }

  function draw(x, y) {
    blank();
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(bmp, 0, 0, size, size);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, size, size);
    // A full stamp right at the cursor, so every single peek names the viewer.
    const [who, wallet] = watermark.split('\n');
    ctx.font = '700 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    [who, wallet].forEach((line, i) => {
      const ty = y + 22 + i * 12;
      ctx.strokeText(line, x, ty);
      ctx.fillText(line, x, ty);
    });
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(232,74,39,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function pos(e) {
    const r = view.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return [p.clientX - r.left, p.clientY - r.top];
  }

  view.addEventListener('pointermove', (e) => draw(...pos(e)));
  view.addEventListener('pointerleave', blank);
  view.addEventListener('touchmove', (e) => { e.preventDefault(); draw(...pos(e)); }, { passive: false });
  view.addEventListener('contextmenu', (e) => e.preventDefault());
  const hide = () => document.hidden && blank();
  document.addEventListener('visibilitychange', hide);
  window.addEventListener('blur', blank);
  blank();

  return () => {
    document.removeEventListener('visibilitychange', hide);
    window.removeEventListener('blur', blank);
    bmp.close();
    container.replaceChildren();
  };
}
