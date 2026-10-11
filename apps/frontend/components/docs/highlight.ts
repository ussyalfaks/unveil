// A tiny syntax highlighter for the docs' code samples (TypeScript, shell, HTTP).
// Not a full parser: it tokenizes line by line, which is enough for short examples.

export type TokenKind = 'kw' | 'str' | 'com' | 'num' | 'fn' | 'type' | 'prop' | 'cmd' | 'plain';
export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set(
  'import from export const let var await async function return if else try catch finally for of in new type interface extends implements true false null undefined throw typeof instanceof as default'.split(
    ' ',
  ),
);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Order matters: comments and strings first, so their contents aren't re-tokenized.
const TS_RULES: [TokenKind, RegExp][] = [
  ['com', /^\/\/.*/],
  ['com', /^\/\*.*?\*\//],
  ['str', /^'(?:\\.|[^'\\])*'/],
  ['str', /^"(?:\\.|[^"\\])*"/],
  ['str', /^`(?:\\.|[^`\\])*`/],
  ['num', /^\d[\d_]*(?:\.\d+)?n?\b/],
  ['plain', /^[A-Za-z_$][\w$]*/], // classified below
  ['plain', /^\s+/],
  ['plain', /^./],
];

function tokenizeTs(line: string): Token[] {
  const out: Token[] = [];
  let rest = line;
  while (rest) {
    for (const [kind, re] of TS_RULES) {
      const m = rest.match(re);
      if (!m) continue;
      const text = m[0];
      let k: TokenKind = kind;
      if (kind === 'plain' && /^[A-Za-z_$]/.test(text)) {
        const after = rest.slice(text.length);
        const before = out.at(-1)?.text ?? '';
        if (KEYWORDS.has(text)) k = 'kw';
        else if (/^\s*\(/.test(after) || /^\s*`/.test(after)) k = 'fn';
        else if (/^[A-Z]/.test(text)) k = 'type';
        else if (before.endsWith('.') || /^\s*:(?!:)/.test(after)) k = 'prop';
      }
      out.push({ kind: k, text });
      rest = rest.slice(text.length);
      break;
    }
  }
  return out;
}

function tokenizeShell(line: string): Token[] {
  const hash = line.indexOf('#');
  const code = hash >= 0 ? line.slice(0, hash) : line;
  const comment = hash >= 0 ? line.slice(hash) : '';
  const out: Token[] = [];
  // KEY=value prefixes, then the command, then arguments
  const m = code.match(/^(\s*(?:[A-Z_]+=\S+\s+)*)(\S+)?(.*)$/);
  if (m) {
    const [, env, cmd, args] = m;
    for (const part of env.split(/(\s+)/)) {
      const kv = part.match(/^([A-Z_]+)=(.*)$/);
      if (kv) out.push({ kind: 'prop', text: kv[1] }, { kind: 'plain', text: '=' }, { kind: 'str', text: kv[2] });
      else if (part) out.push({ kind: 'plain', text: part });
    }
    if (cmd) out.push({ kind: 'cmd', text: cmd });
    for (const part of (args ?? '').split(/(\s+)/)) {
      if (!part) continue;
      out.push({ kind: /^-/.test(part) ? 'kw' : /^\d+$/.test(part) ? 'num' : 'plain', text: part });
    }
  }
  if (comment) out.push({ kind: 'com', text: comment });
  return out;
}

function tokenizeHttp(line: string): Token[] {
  const word = line.match(/^(\s*)(\S+)(.*)$/);
  if (word && HTTP_METHODS.has(word[2])) {
    return [{ kind: 'plain', text: word[1] }, { kind: 'kw', text: word[2] }, ...tokenizeTs(word[3])];
  }
  return tokenizeTs(line);
}

export function highlight(code: string, lang: string): Token[][] {
  const tokenize = lang === 'bash' ? tokenizeShell : lang === 'http' ? tokenizeHttp : tokenizeTs;
  return code.split('\n').map(tokenize);
}
