// Shows a decrypted photo one small circle at a time, under the pointer.
// Every visible pixel carries the viewer's watermark, so stitched
// screenshots still name whoever leaked them.
//
// Honest limit: the decrypted image lives in this tab's memory. A determined
// viewer with dev tools can pull it out. The peephole raises the effort and
// the watermark + on-chain deposit raise the cost; neither makes it impossible.
import type { Bytes } from './crypto.js';

export interface PeepholeOptions {
  /** Lines stamped across the image, e.g. [name, wallet · #id, timestamp]. */
  watermark: string[];
  /** Radius of the visible circle in CSS pixels. Default 58. */
  radius?: number;
  /** Max canvas size in CSS pixels. Default 420. */
  maxSize?: number;
  /** Colours. */
  background?: string;
  hintColor?: string;
  ringColor?: string;
  hint?: string;
  font?: string;
}

/** Render the peephole into `container`. Returns a cleanup function. */
export async function openPeephole(container: HTMLElement, jpeg: Bytes, opts: PeepholeOptions): Promise<() => void> {
  const {
    watermark,
    radius = 58,
    maxSize = 420,
    background = '#050806',
    hintColor = '#2f6b3f',
    ringColor = 'rgba(57,255,106,0.9)',
    hint = '> move over the frame to peek_',
    font = '"JetBrains Mono", ui-monospace, monospace',
  } = opts;

  const bmp = await createImageBitmap(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }));
  const size = Math.min(container.clientWidth || maxSize, maxSize);

  const view = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  view.width = size * dpr;
  view.height = size * dpr;
  view.style.width = size + 'px';
  view.style.height = size + 'px';
  view.style.touchAction = 'none';
  view.style.userSelect = 'none';
  view.style.cursor = 'none';
  view.className = 'peephole-canvas';
  view.setAttribute('aria-label', 'Hidden photo. Move your pointer over it to reveal one small area at a time.');
  container.replaceChildren(view);

  const ctx = view.getContext('2d')!;
  ctx.scale(dpr, dpr);

  // Pre-render a watermark tile once.
  const tile = document.createElement('canvas');
  tile.width = 170;
  tile.height = 64;
  const t = tile.getContext('2d')!;
  t.translate(85, 32);
  t.rotate(-0.35);
  t.font = `600 9px ${font}`;
  t.textAlign = 'center';
  t.fillStyle = 'rgba(255,255,255,0.45)';
  t.strokeStyle = 'rgba(0,0,0,0.45)';
  t.lineWidth = 2;
  watermark.forEach((line, i, arr) => {
    const y = (i - (arr.length - 1) / 2) * 11;
    t.strokeText(line, 0, y);
    t.fillText(line, 0, y);
  });
  const pattern = ctx.createPattern(tile, 'repeat')!;

  function blank() {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = hintColor;
    ctx.font = `500 13px ${font}`;
    ctx.textAlign = 'center';
    ctx.fillText(hint, size / 2, size / 2);
  }

  function draw(x: number, y: number) {
    blank();
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(bmp, 0, 0, size, size);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, size, size);
    // A full stamp right at the cursor, so every single peek names the viewer.
    ctx.font = `700 10px ${font}`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    watermark.slice(0, 2).forEach((line, i) => {
      const ty = y + 22 + i * 12;
      ctx.strokeText(line, x, ty);
      ctx.fillText(line, x, ty);
    });
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function pos(e: PointerEvent | TouchEvent): [number, number] {
    const r = view.getBoundingClientRect();
    const p = 'touches' in e ? e.touches[0] : e;
    return [p.clientX - r.left, p.clientY - r.top];
  }

  const onMove = (e: PointerEvent) => draw(...pos(e));
  const onTouch = (e: TouchEvent) => {
    e.preventDefault();
    draw(...pos(e));
  };
  const noMenu = (e: Event) => e.preventDefault();
  const hide = () => document.hidden && blank();

  view.addEventListener('pointermove', onMove);
  view.addEventListener('pointerleave', blank);
  view.addEventListener('touchmove', onTouch, { passive: false });
  view.addEventListener('contextmenu', noMenu);
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
