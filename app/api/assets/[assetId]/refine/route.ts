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
      specOverrides?: RefinementRequest['specOverrides'];
    };

    if (!body.instruction?.trim()) return apiError('Describe the change you want');

    const versionId = body.versionId ?? asset.currentVersionId;
    if (!versionId) return apiError('This piece has no version to refine yet');

    const parent = await store.getAssetVersion(versionId);
    if (!parent || parent.assetId !== asset.id) return apiError('Version not found', 404);

    const refinement: RefinementRequest = {
      instruction: body.instruction.trim(),
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
