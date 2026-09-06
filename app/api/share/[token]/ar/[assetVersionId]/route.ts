import { apiError } from '@/lib/api';
import { buildArGlb } from '@/lib/share/ar';
import { referencedAssetVersionIds, resolveShareToken } from '@/lib/share/access';

type Params = { params: Promise<{ token: string; assetVersionId: string }> };

/**
 * A single staged piece's mesh, re-scaled and grounded for a phone AR
 * session (see lib/share/ar.ts) - what the share view's "View in AR" button
 * points `<model-viewer src>` at.
 *
 * Scoped by the share token exactly like the local-mode blob route: only an
 * asset version the shared scene actually stages is servable, and this works
 * the same way in both storage backends (unlike `shareBlobUrl`, which hands
 * Supabase mode a direct signed Storage URL) because the raw stored mesh
 * needs the fit/offset correction applied server-side either way.
 */
export async function GET(_request: Request, { params }: Params) {
  const { token, assetVersionId } = await params;
  const resolution = await resolveShareToken(token);
  if (!resolution.ok) return apiError(resolution.message, resolution.status);
  const { store, scene } = resolution.context;

  if (!referencedAssetVersionIds(scene).has(assetVersionId)) {
    return apiError('Not found', 404);
  }

  const version = await store.getAssetVersion(assetVersionId);
  if (!version?.meshPath) return apiError('Not found', 404);

  const blob = await store.getBlob(version.meshPath);
  if (!blob) return apiError('Not found', 404);

  const targetLongestM =
    Math.max(
      version.spec.dimensions.widthMm,
      version.spec.dimensions.depthMm,
      version.spec.dimensions.heightMm,
    ) / 1000;

  let bytes: Uint8Array;
  try {
    bytes = await buildArGlb({ glb: blob.bytes, meshExtentMm: version.meshExtentMm, targetLongestM });
  } catch (cause) {
    console.error('[share/ar] could not build AR glb', cause instanceof Error ? cause.message : cause);
    return apiError('Could not prepare this piece for AR', 500);
  }

  return new Response(bytes as BodyInit, {
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
