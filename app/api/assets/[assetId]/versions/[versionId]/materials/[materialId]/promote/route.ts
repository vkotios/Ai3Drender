import { apiError, json, withAsset } from '@/lib/api';
import type { MaterialSpec } from '@/lib/types';

type Params = { params: Promise<{ assetId: string; versionId: string; materialId: string }> };

interface PromoteBody {
  /** Override the material's own name for the library entry. Optional. */
  name?: string;
  code?: string | null;
}

/**
 * Turn an invented, ad hoc material into a library entry, then bind this
 * spec's material to the entry just created - closing the review loop the
 * vision pass's `invented` flag exists for: a human looks at what got
 * invented and decides whether it is actually a new material worth keeping.
 */
export async function POST(request: Request, { params }: Params) {
  const { assetId, versionId, materialId } = await params;
  return withAsset(assetId, async ({ store, viewer }, asset) => {
    const version = await store.getAssetVersion(versionId);
    if (!version || version.assetId !== asset.id) return apiError('Version not found', 404);
    if (version.acceptedAt) {
      return apiError('This version is accepted and immutable; refine the piece instead', 409);
    }

    const material = version.spec.materials.find((m) => m.id === materialId);
    if (!material) return apiError('Material not found on this version', 404);

    const body = (await request.json().catch(() => ({}))) as PromoteBody;

    const entry = await store.createMaterialLibraryEntry({
      ownerId: viewer.id,
      name: body.name?.trim() || material.name,
      code: body.code?.trim() || null,
      kind: material.kind,
      baseColorHex: material.baseColorHex,
      roughness: material.roughness,
      metalness: material.metalness,
      sheen: material.sheen,
      clearcoat: material.clearcoat,
      finish: material.finish,
      notes: material.notes,
      swatchPath: null,
      archivedAt: null,
    });

    const bound: MaterialSpec = { ...material, libraryEntryId: entry.id, invented: false };
    const spec = {
      ...version.spec,
      materials: version.spec.materials.map((m) => (m.id === materialId ? bound : m)),
    };
    await store.updateAssetVersion(version.id, { spec });

    return json({ entry }, 201);
  });
}
