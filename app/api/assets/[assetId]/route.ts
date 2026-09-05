import { json, withAsset } from '@/lib/api';

type Params = { params: Promise<{ assetId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { assetId } = await params;
  return withAsset(assetId, async ({ store }, asset) =>
    json({
      asset,
      versions: await store.listAssetVersions(asset.id),
      sourceImages: await store.getSourceImages(asset.sourceImageIds),
    }),
  );
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
