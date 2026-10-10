'use client';

import { useEffect, useState, type DependencyList } from 'react';
import type { Status } from '@unveil/sdk';
import { errorMessage } from '@/lib/format';
import { useUnveil } from './UnveilProvider';

/** A button that shows a busy label while its async action runs, and toasts errors. */
export function ActionButton({
  label,
  busyLabel = 'Working…',
  className,
  disabled,
  onClick,
}: {
  label: string;
  busyLabel?: string;
  className?: string;
  disabled?: boolean;
  onClick: () => Promise<unknown>;
}) {
  const { toast } = useUnveil();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } catch (e) {
          console.error(e);
          toast(errorMessage(e), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? busyLabel : label}
    </button>
  );
}

export function StatusPill({ status }: { status: Status }) {
  return <span className={`pill s-${status.toLowerCase()}`}>{status}</span>;
}

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="1" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export function CopyButton({ text, what = 'Address' }: { text: string; what?: string }) {
  const { toast } = useUnveil();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`icon-btn${done ? ' done' : ''}`}
      title={`Copy ${what.toLowerCase()}`}
      aria-label={`Copy ${what.toLowerCase()}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          return toast(`Could not copy. Select the ${what.toLowerCase()} and copy it manually.`, 'error');
        }
        setDone(true);
        toast(`${what} copied`, 'ok');
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** Load async data; reloads when deps change. Errors are toasted. */
export function useLoad<T>(fn: () => Promise<T> | null, deps: DependencyList): { data: T | null; loading: boolean } {
  const { toast } = useUnveil();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const p = fn();
    if (!p) {
      setData(null);
      return;
    }
    let live = true;
    setLoading(true);
    p.then((d) => live && setData(d))
      .catch((e) => live && toast(errorMessage(e), 'error'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, loading };
}

/** Ask the user for a file. Resolves to null if they cancel. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export function downloadText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
