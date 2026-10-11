import { fromUnits } from 'unveil-sdk';
import { TOKEN_SYMBOL } from './config';

export const short = (a?: string | null) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

export const fmtAmt = (units: bigint) =>
  fromUnits(units).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ' + TOKEN_SYMBOL;

export const when = (s: number) => (s ? new Date(s * 1000).toLocaleString() : '—');

export function ago(s: number): string {
  const d = Math.max(0, Date.now() / 1000 - s);
  if (d < 90) return `${Math.round(d)}s ago`;
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 129600) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
}

/** 300 → "5 minutes", 604800 → "7 days" */
export function period(secs: number): string {
  if (secs >= 86400) return `${Math.round(secs / 86400)} days`;
  if (secs >= 3600) return `${Math.round(secs / 3600)} hours`;
  return `${Math.max(1, Math.round(secs / 60))} minutes`;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
