import { correctMaterial } from '@/lib/ai/gemini';
import { apiError, json, withAsset } from '@/lib/api';
import type { MaterialSpec } from '@/lib/types';

type Params = { params: Promise<{ assetId: string; versionId: string; materialId: string }> };

interface RebindBody {
  /** Bind to a library entry's canonical values (the original behaviour). */
  libraryEntryId?: string;
  /**
   * Spot-fix this one material with a free-text correction ("make this darker
   * walnut") instead - the lighter alternative to a full refine round. See
   * `correctMaterial` in lib/ai/gemini.ts. Mutually exclusive with
   * `libraryEntryId`.
   */
  instruction?: string;
}

/**
 * Rebind or spot-fix one material entry in a version's spec.
 *
 * `materialId` addresses `spec.materials[].id`, not the library entry - and
 * every `FurnitureComponent` in this spec whose `materialId` points at that
 * same entry changes appearance together, since they all read from the one
 * array element this updates. That sharing is what "propagates to every piece
 * using it" means for a single spec.
 *
 * Two mutually exclusive request shapes:
 *  - `{ libraryEntryId }` rebinds to a library entry's canonical PBR values
 *    (not whatever the piece's own material happened to have), so the piece
 *    renders identically to every other piece bound to the same entry rather
 *    than merely similarly.
 *  - `{ instruction }` spot-fixes the material's PBR values from a free-text
 *    correction, going straight to `correctMaterial` instead of the full
 *    spec-and-mesh refine pipeline. Because the result is now specific to
 *    this instance and no longer matches any library entry's canonical
 *    values, the material is unbound (`libraryEntryId: null`) and flagged
 *    `invented: true`, exactly like a vision pass that couldn't match a
 *    surface against the library - see `MaterialSpec.libraryEntryId`.
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

    const body = (await request.json().catch(() => ({}))) as RebindBody;

    let bound: MaterialSpec;
    if (body.libraryEntryId) {
      const candidate = await store.getMaterialLibraryEntry(body.libraryEntryId);
      if (!candidate || candidate.ownerId !== viewer.id) {
        return apiError('Library material not found', 404);
      }

      bound = {
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
    } else if (body.instruction?.trim()) {
      const correction = await correctMaterial(material, body.instruction.trim());
      bound = {
        ...material,
        baseColorHex: correction.baseColorHex,
        roughness: correction.roughness,
        metalness: correction.metalness,
        sheen: correction.sheen,
        clearcoat: correction.clearcoat,
        finish: correction.finish,
        notes: correction.notes,
        libraryEntryId: null,
        invented: true,
      };
    } else {
      return apiError('Either libraryEntryId or instruction is required');
    }

    const spec = {
      ...version.spec,
      materials: version.spec.materials.map((m) => (m.id === materialId ? bound : m)),
    };

    const updated = await store.updateAssetVersion(version.id, { spec });
    return json(updated);
  });
}
