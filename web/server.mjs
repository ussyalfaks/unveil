// Tiny storage server. It only ever receives ciphertext (photos) and NDA
// text, and stores each under the SHA-256 of its bytes. Because the hash is
// also on-chain, the server can't swap a file without being caught.
// It also serves the built app from ./dist.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const DATA = process.env.DATA_DIR || join(root, 'data');
const DIST = join(root, 'dist');
const PORT = Number(process.env.PORT || 8787);
const MAX = 3 * 1024 * 1024;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

await mkdir(DATA, { recursive: true });

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/blob') {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX) return send(res, 413, 'too large');
        chunks.push(c);
      }
      const body = Buffer.concat(chunks);
      if (!body.length) return send(res, 400, 'empty');
      const hash = createHash('sha256').update(body).digest('hex');
      await writeFile(join(DATA, hash), body);
      return send(res, 200, JSON.stringify({ hash }), 'application/json');
    }
    const m = url.pathname.match(/^\/api\/blob\/([0-9a-f]{64})$/);
    if (req.method === 'GET' && m) {
      try {
        return send(res, 200, await readFile(join(DATA, m[1])), 'application/octet-stream');
      } catch {
        return send(res, 404, 'not found');
      }
    }
    if (req.method === 'GET') {
      let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      let file = join(DIST, p);
      if (!file.startsWith(DIST)) return send(res, 403, 'no');
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      } catch {
        file = join(DIST, 'index.html');
      }
      return send(res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream');
    }
    send(res, 405, 'method not allowed');
  } catch (e) {
    console.error(e);
    send(res, 500, 'server error');
  }
});

server.listen(PORT, () => console.log(`Unveil running on http://localhost:${PORT}`));
