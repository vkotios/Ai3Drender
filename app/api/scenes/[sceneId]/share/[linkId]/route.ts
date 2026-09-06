import { apiError, json, withScene } from '@/lib/api';

type Params = { params: Promise<{ sceneId: string; linkId: string }> };

/** Revoke a share link. Idempotent - revoking twice just keeps the first timestamp. */
export async function DELETE(_request: Request, { params }: Params) {
  const { sceneId, linkId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    const link = await store.getShareLink(linkId);
    if (!link || link.sceneId !== scene.id) return apiError('Share link not found', 404);
    return json(await store.revokeShareLink(linkId));
  });
}
