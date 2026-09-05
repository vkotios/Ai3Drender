import { apiError, json, withAsset } from '@/lib/api';

type Params = { params: Promise<{ assetId: string; versionId: string }> };

/**
 * Sign a version off. An accepted version becomes immutable (enforced by a
 * Postgres trigger and mirrored in the local store), so downstream renders and
 * customer approvals stay reproducible.
 */
export async function POST(_request: Request, { params }: Params) {
  const { assetId, versionId } = await params;
  return withAsset(assetId, async ({ store }, asset) => {
    const version = await store.getAssetVersion(versionId);
    if (!version || version.assetId !== asset.id) return apiError('Version not found', 404);
    if (!version.meshPath) return apiError('Cannot accept a version that has no mesh yet');

    const accepted = await store.updateAssetVersion(version.id, {
      acceptedAt: new Date().toISOString(),
    });
    await store.updateAsset(asset.id, { currentVersionId: accepted.id });
    return json(accepted);
  });
}

/** Withdraw acceptance, making the version editable again. */
export async function DELETE(_request: Request, { params }: Params) {
  const { assetId, versionId } = await params;
  return withAsset(assetId, async ({ store }, asset) => {
    const version = await store.getAssetVersion(versionId);
    if (!version || version.assetId !== asset.id) return apiError('Version not found', 404);
    return json(await store.updateAssetVersion(version.id, { acceptedAt: null }));
  });
}
