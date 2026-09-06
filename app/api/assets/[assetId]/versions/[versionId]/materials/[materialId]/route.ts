import { apiError, json, withAsset } from '@/lib/api';
import type { MaterialSpec } from '@/lib/types';

type Params = { params: Promise<{ assetId: string; versionId: string; materialId: string }> };

/**
 * Rebind one material entry in a version's spec to a library entry.
 *
 * `materialId` addresses `spec.materials[].id`, not the library entry - and
 * every `FurnitureComponent` in this spec whose `materialId` points at that
 * same entry changes appearance together, since they all read from the one
 * array element this updates. That sharing is what "propagates to every piece
 * using it" means for a single spec; the entry's canonical PBR values (not
 * whatever the piece's own material happened to have) are what get written,
 * so the piece renders identically to every other piece bound to the same
 * entry rather than merely similarly.
 *
 * Blocked on an accepted version for the same reason every other spec edit
 * is: an accepted version is a frozen contract with the customer. Refine the
 * piece (which forks a new version) to change a material there instead.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { assetId, versionId, materialId } = await params;
  return withAsset(assetId, async ({ store, viewer }, asset) => {
    const version = await store.getAssetVersion(versionId);
    if (!version || version.assetId !== asset.id) return apiError('Version not found', 404);
    if (version.acceptedAt) {
      return apiError('This version is accepted and immutable; refine the piece instead', 409);
    }

    const material = version.spec.materials.find((m) => m.id === materialId);
    if (!material) return apiError('Material not found on this version', 404);

    const body = (await request.json()) as { libraryEntryId?: string };
    if (!body.libraryEntryId) return apiError('libraryEntryId is required');

    const candidate = await store.getMaterialLibraryEntry(body.libraryEntryId);
    if (!candidate || candidate.ownerId !== viewer.id) {
      return apiError('Library material not found', 404);
    }

    const bound: MaterialSpec = {
      ...material,
      name: candidate.name,
      kind: candidate.kind,
      baseColorHex: candidate.baseColorHex,
      roughness: candidate.roughness,
      metalness: candidate.metalness,
      sheen: candidate.sheen,
      clearcoat: candidate.clearcoat,
      finish: candidate.finish,
      libraryEntryId: candidate.id,
      invented: false,
    };

    const spec = {
      ...version.spec,
      materials: version.spec.materials.map((m) => (m.id === materialId ? bound : m)),
    };

    const updated = await store.updateAssetVersion(version.id, { spec });
    return json(updated);
  });
}
