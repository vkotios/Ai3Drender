import { apiError } from '@/lib/api';
import { hasSupabase } from '@/lib/env';
import { referencedAssetVersionIds, resolveShareToken } from '@/lib/share/access';

type Params = { params: Promise<{ token: string; key: string[] }> };

/**
 * Serve a mesh blob to the share view in local mode.
 *
 * Mirrors app/api/blob/[...key]/route.ts, but scoped to a share token instead
 * of a session: only a mesh path that belongs to a version the shared scene
 * actually stages is servable, regardless of what key is asked for. That
 * includes a version's decimated `previewMeshPath` (see issue #47) alongside
 * its full-detail `meshPath` - the share view displays whichever the scene
 * page resolved for it.
 */
export async function GET(_request: Request, { params }: Params) {
  if (hasSupabase) return apiError('Blobs are served from Supabase Storage', 404);

  const { token, key } = await params;
  const resolution = await resolveShareToken(token);
  if (!resolution.ok) return apiError(resolution.message, resolution.status);
  const { store, scene } = resolution.context;

  const path = key.map(decodeURIComponent).join('/');

  const versionIds = [...referencedAssetVersionIds(scene)];
  const versions = await Promise.all(versionIds.map((id) => store.getAssetVersion(id)));
  const allowed = versions.some((v) => v?.meshPath === path || v?.previewMeshPath === path);
  if (!allowed) return apiError('Not found', 404);

  const blob = await store.getBlob(path);
  if (!blob) return apiError('Not found', 404);

  return new Response(blob.bytes as BodyInit, {
    headers: {
      'Content-Type': blob.contentType,
      'Content-Length': String(blob.bytes.byteLength),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
