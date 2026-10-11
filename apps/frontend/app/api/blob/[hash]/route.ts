import { getBlob } from '@/lib/blob-store';

export const runtime = 'nodejs';

// GET /api/blob/<sha256 hex>  →  bytes
export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const bytes = await getBlob(hash);
  if (!bytes) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/octet-stream',
      // Content-addressed: the bytes for a hash never change.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
