'use client';

import { useMemo, useState } from 'react';
import { highlight } from './highlight';

const DEFAULT_FILE: Record<string, string> = { ts: 'example.ts', bash: 'terminal', http: 'storage.http' };

/** A code sample styled like an editor window: file tab, line numbers, syntax colours, copy button. */
export function CodeBlock({ code, lang = 'ts', title }: { code: string; lang?: string; title?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
  const text = code.trim();
  const lines = useMemo(() => highlight(text, lang), [text, lang]);
  const file = title ?? DEFAULT_FILE[lang] ?? lang;

  return (
    <figure className={`editor lang-${lang}`}>
      <figcaption className="editor-bar">
        <span className="editor-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="editor-tab">{file}</span>
        <span className="editor-lang" aria-hidden="true">
          {lang}
        </span>
        <button
          type="button"
          className="code-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setState('done');
            } catch {
              setState('fail');
            }
            setTimeout(() => setState('idle'), 1500);
          }}
        >
          {state === 'done' ? 'copied' : state === 'fail' ? 'select & copy' : 'copy'}
        </button>
      </figcaption>
      <pre className="editor-body">
        <code>
          {lines.map((tokens, i) => (
            <span key={i} className="ln">
              {tokens.length ? tokens.map((t, j) => (t.kind === 'plain' ? t.text : <span key={j} className={`t-${t.kind}`}>{t.text}</span>)) : ' '}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
