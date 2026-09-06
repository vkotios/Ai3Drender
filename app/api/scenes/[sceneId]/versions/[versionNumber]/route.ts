import { apiError, json, withScene } from '@/lib/api';

type Params = { params: Promise<{ sceneId: string; versionNumber: string }> };

/** Restore a scene's `doc` to a past save. Recorded as a new save in its own right. */
export async function POST(_request: Request, { params }: Params) {
  const { sceneId, versionNumber } = await params;
  const parsed = Number(versionNumber);
  if (!Number.isInteger(parsed)) return apiError(`Invalid version number ${versionNumber}`);

  return withScene(sceneId, async ({ store }, scene) => {
    const target = await store.getSceneVersion(scene.id, parsed);
    if (!target) return apiError(`Version ${parsed} not found`, 404);

    // No expectedVersion: restoring is a deliberate, explicit action taken
    // from the version history UI, not a stale editor silently overwriting.
    const restored = await store.updateScene(
      scene.id,
      { doc: target.doc },
      `restored to version ${target.versionNumber}`,
    );
    return json(restored);
  });
}
