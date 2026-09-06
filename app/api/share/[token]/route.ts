import { apiError, json } from '@/lib/api';
import { viewportMeshPath } from '@/lib/db/store';
import { referencedAssetVersionIds, resolveShareToken } from '@/lib/share/access';
import { shareBlobUrl } from '@/lib/share/blob';

type Params = { params: Promise<{ token: string }> };

/**
 * Everything the read-only share view needs in one round trip: the scene, the
 * asset versions it stages (with a fetchable mesh URL), and the notes already
 * pinned on them - internal and client-authored alike, so a client sees the
 * conversation they are joining.
 */
export async function GET(_request: Request, { params }: Params) {
  const { token } = await params;
  const resolution = await resolveShareToken(token);
  if (!resolution.ok) return apiError(resolution.message, resolution.status);
  const { store, scene } = resolution.context;

  const versionIds = [...referencedAssetVersionIds(scene)];
  const versions = [];
  for (const id of versionIds) {
    const version = await store.getAssetVersion(id);
    if (!version) continue;
    // Prefer the decimated preview mesh (issue #47), same as the SSR share
    // page and the authenticated studio routes - see lib/db/store.ts's
    // viewportMeshPath.
    const meshKey = viewportMeshPath(version);
    versions.push({
      version,
      meshUrl: meshKey ? await shareBlobUrl(store, token, meshKey) : null,
    });
  }

  const assetIds = [...new Set(versions.map((v) => v.version.assetId))];

  // The full scene row has nothing sensitive on it beyond what the studio
  // already shows - returning it as-is keeps this response shaped exactly
  // like the authenticated GET /api/scenes/[sceneId], so the same studio
  // store and components work in both places.
  return json({
    scene,
    versions,
    annotations: await store.listAnnotations(assetIds),
  });
}
