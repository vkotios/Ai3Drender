import { blobUrlWithExpiry } from '@/lib/db';
import { json, withAsset } from '@/lib/api';

type Params = { params: Promise<{ assetId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { assetId } = await params;
  return withAsset(assetId, async ({ store }, asset) => {
    const versions = await store.listAssetVersions(asset.id);
    // Version compare needs a fetchable mesh (and, when cached, a preview) for
    // every version, not just the current one - each with its own expiry, so
    // a version preloaded ahead of time still gets refreshed before it goes
    // stale (see MeshUrlBoundary), the same as the version staged up front.
    const resolved = await Promise.all(
      versions.map(async (version) => {
        const mesh = version.meshPath
          ? await blobUrlWithExpiry(store, version.meshPath)
          : { url: null, expiresAt: null };
        return {
          version,
          meshUrl: mesh.url,
          meshUrlExpiresAt: mesh.expiresAt,
          previewUrl: version.previewPath ? await store.blobUrl(version.previewPath) : null,
        };
      }),
    );
    return json({
      asset,
      versions: resolved,
      sourceImages: await store.getSourceImages(asset.sourceImageIds),
    });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const { assetId } = await params;
  const body = (await request.json()) as { name?: string; currentVersionId?: string };
  return withAsset(assetId, async ({ store }, asset) => json(await store.updateAsset(asset.id, body)));
}

export async function DELETE(_request: Request, { params }: Params) {
  const { assetId } = await params;
  return withAsset(assetId, async ({ store }, asset) => {
    await store.deleteAsset(asset.id);
    return json({ deleted: true });
  });
}
