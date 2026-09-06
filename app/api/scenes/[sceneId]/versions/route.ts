import { json, withScene } from '@/lib/api';

type Params = { params: Promise<{ sceneId: string }> };

/** Every retained save of this scene's `doc`, newest first. */
export async function GET(_request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => json(await store.listSceneVersions(scene.id)));
}
