import { getSession } from '@/lib/db';
import { apiError } from '@/lib/api';
import { hasSupabase } from '@/lib/env';

type Params = { params: Promise<{ key: string[] }> };

/**
 * Serve a stored object in local mode.
 *
 * With Supabase configured, blobs are handed out as signed Storage URLs and
 * this route is unused - it refuses rather than becoming a second, unsigned
 * way to read the same bucket.
 */
export async function GET(_request: Request, { params }: Params) {
  if (hasSupabase) return apiError('Blobs are served from Supabase Storage', 404);

  const session = await getSession();
  if (!session) return apiError('Not signed in', 401);

  const { key } = await params;
  const path = key.map(decodeURIComponent).join('/');

  // Keys start with the project id; check the caller owns it before reading.
  const [projectId] = path.split('/');
  const project = await session.store.getProject(projectId);
  if (!project || project.ownerId !== session.viewer.id) return apiError('Not found', 404);

  const blob = await session.store.getBlob(path);
  if (!blob) return apiError('Not found', 404);

  return new Response(blob.bytes as BodyInit, {
    headers: {
      'Content-Type': blob.contentType,
      'Content-Length': String(blob.bytes.byteLength),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
