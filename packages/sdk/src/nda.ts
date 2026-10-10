export interface NdaFields {
  /** Recipient's name; also stamped on every view of the photo. */
  recipient: string;
  organisation?: string;
  recipientWallet: string;
  discloserWallet: string;
  purpose?: string;
  /** Human-readable deposit, e.g. "50". */
  deposit: string;
  tokenSymbol: string;
  watchSecs?: number;
}

function watchPeriod(secs?: number): string {
  if (secs === undefined) return '[watch period]';
  if (secs >= 86400) return `${Math.round(secs / 86400)} days`;
  if (secs >= 3600) return `${Math.round(secs / 3600)} hours`;
  return `${Math.max(1, Math.round(secs / 60))} minutes`;
}

/**
 * The reference NDA. Its SHA-256 goes on-chain in the transaction that locks
 * the deposit, so the requester's Stellar signature is their signature on it.
 */
export function buildNda(f: NdaFields): string {
  return `UNVEIL CONFIDENTIALITY AGREEMENT v1

Recipient: ${f.recipient.trim() || '[your name]'}
Organisation: ${f.organisation?.trim() || '[organisation]'}
Recipient wallet: ${f.recipientWallet || '[connect wallet]'}
Discloser wallet: ${f.discloserWallet || '[anon address]'}
Purpose: ${f.purpose?.trim() || '[purpose]'}

1. The Recipient will view the Discloser's photo only for the Purpose above.
2. The Recipient will not copy, screenshot, record, store or share the photo, and will not describe the Discloser's appearance or identity to anyone.
3. The Recipient accepts that every view is watermarked with their name and wallet, and that a deposit of ${f.deposit || '[amount]'} ${f.tokenSymbol} is locked on Stellar for ${watchPeriod(f.watchSecs)} after the reveal and paid to the Discloser if a leak is proven.
4. Signing the Stellar transaction that carries this agreement's SHA-256 hash is the Recipient's signature.`;
}

/** The recipient's name from an NDA built with `buildNda`. */
export function ndaRecipient(text: string | null | undefined): string {
  return text?.match(/^Recipient: (.+)$/m)?.[1] ?? 'unknown recipient';
}
