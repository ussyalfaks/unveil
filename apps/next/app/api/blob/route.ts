import { MAX_BYTES, putBlob } from '@/lib/blob-store';

export const runtime = 'nodejs';

// POST /api/blob  body: bytes  →  { hash }
export async function POST(req: Request) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return new Response('too large', { status: 413 });
  const body = new Uint8Array(await req.arrayBuffer());
  if (!body.length) return new Response('empty', { status: 400 });
  if (body.length > MAX_BYTES) return new Response('too large', { status: 413 });
  return Response.json({ hash: await putBlob(body) });
}
