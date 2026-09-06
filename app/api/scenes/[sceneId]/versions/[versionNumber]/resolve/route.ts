import { apiError, json, withScene } from '@/lib/api';
import { blobUrlWithExpiry } from '@/lib/db';

type Params = { params: Promise<{ sceneId: string; versionNumber: string }> };

/**
 * A past save's `doc`, plus a fetchable mesh URL for every asset version it
 * references - the same shape `GET /api/scenes/[sceneId]` returns for the
 * live scene, but for one specific retained version instead.
 *
 * Exists for the side-by-side compare view: two past saves rendered at once
 * need their own meshes resolved, since the doc they came from may reference
 * an asset version older than whatever the live scene (and the studio's
 * already-loaded `versions` map) currently points at.
 */
export async function GET(_request: Request, { params }: Params) {
  const { sceneId, versionNumber } = await params;
  const parsed = Number(versionNumber);
  if (!Number.isInteger(parsed)) return apiError(`Invalid version number ${versionNumber}`);

  return withScene(sceneId, async ({ store }, scene) => {
    const target = await store.getSceneVersion(scene.id, parsed);
    if (!target) return apiError(`Version ${parsed} not found`, 404);

    const versionIds = [
      ...new Set(target.doc.nodes.map((n) => n.assetVersionId).filter((id): id is string => !!id)),
    ];
    const versions = [];
    for (const id of versionIds) {
      const version = await store.getAssetVersion(id);
      if (!version) continue;
      const resolved = version.meshPath
        ? await blobUrlWithExpiry(store, version.meshPath)
        : { url: null, expiresAt: null };
      versions.push({ version, meshUrl: resolved.url, meshUrlExpiresAt: resolved.expiresAt });
    }

    return json({ sceneVersion: target, versions });
  });
}
