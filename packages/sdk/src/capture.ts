import type { Bytes } from './crypto.js';

export interface CapturedPhoto {
  /** Stamped JPEG bytes. */
  bytes: Bytes;
  /** Unix seconds when it was taken. */
  capturedAt: number;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Open the front camera. Stop it with `stopCamera(stream)`. */
export function startCamera(size = 640): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: size, height: size }, audio: false });
}

export function stopCamera(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * Grab a square selfie from a playing <video>, mirror it, and burn the wallet
 * and time into the pixels: proof the photo was taken for this wallet, now.
 * Optionally draws the result onto `preview`.
 */
export async function capturePhoto(
  video: HTMLVideoElement,
  address: string,
  opts: { size?: number; quality?: number; preview?: HTMLCanvasElement } = {},
): Promise<CapturedPhoto> {
  const { size = 480, quality = 0.9 } = opts;
  if (!video.videoWidth) throw new Error('Camera is not ready yet');
  const cv = opts.preview ?? document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const s = Math.min(video.videoWidth, video.videoHeight);
  ctx.save();
  ctx.translate(size, 0);
  ctx.scale(-1, 1); // mirror like a selfie
  ctx.drawImage(video, (video.videoWidth - s) / 2, (video.videoHeight - s) / 2, s, s, 0, 0, size, size);
  ctx.restore();

  const capturedAt = Math.floor(Date.now() / 1000);
  const bar = Math.round(size * 0.07);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, size - bar, size, bar);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.round(size / 40)}px "JetBrains Mono", monospace`;
  const stamp = new Date(capturedAt * 1000).toISOString().replace('T', ' ').slice(0, 19);
  ctx.fillText(`UNVEIL · ${short(address)} · ${stamp}Z`, 12, size - bar / 2 + 4);

  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not encode the photo');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), capturedAt };
}
