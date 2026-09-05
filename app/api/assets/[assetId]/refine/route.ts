import { apiError, json, withAsset } from '@/lib/api';
import type { RefinementRequest } from '@/lib/types';

type Params = { params: Promise<{ assetId: string }> };

/**
 * Spin a new version off an existing one.
 *
 * `rebuildMesh: false` is the cheap path - it revises the specification and
 * materials only, which is what most "make the legs darker" style notes need.
 * `true` re-runs reconstruction and costs a vendor call.
 */
export async function POST(request: Request, { params }: Params) {
  const { assetId } = await params;
  return withAsset(assetId, async ({ store }, asset) => {
    const body = (await request.json()) as {
      versionId?: string;
      instruction?: string;
      rebuildMesh?: boolean;
      annotationIds?: string[];
      specOverrides?: RefinementRequest['specOverrides'];
    };

    // Either a written instruction or a set of pinned notes is enough to act on.
    const annotationIds = body.annotationIds ?? [];
    if (!body.instruction?.trim() && annotationIds.length === 0) {
      return apiError('Describe the change you want, or pin at least one note');
    }

    if (annotationIds.length > 0) {
      const owned = new Set((await store.listAnnotations([asset.id])).map((a) => a.id));
      if (annotationIds.some((id) => !owned.has(id))) {
        return apiError('One or more notes do not belong to this piece');
      }
    }

    const versionId = body.versionId ?? asset.currentVersionId;
    if (!versionId) return apiError('This piece has no version to refine yet');

    const parent = await store.getAssetVersion(versionId);
    if (!parent || parent.assetId !== asset.id) return apiError('Version not found', 404);

    const refinement: RefinementRequest = {
      instruction: body.instruction?.trim() ?? '',
      annotationIds,
      rebuildMesh: body.rebuildMesh ?? false,
      specOverrides: body.specOverrides,
    };

    const job = await store.createJob({
      projectId: asset.projectId,
      assetId: asset.id,
      kind: 'refine',
      input: { versionId: parent.id, refinement },
    });

    return json({ job }, 202);
  });
}
