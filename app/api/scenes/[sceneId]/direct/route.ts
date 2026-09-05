import { json, withScene } from '@/lib/api';

type Params = { params: Promise<{ sceneId: string }> };

/** Ask the model to art-direct the booth around the pieces already staged. */
export async function POST(_request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    const job = await store.createJob({
      projectId: scene.projectId,
      kind: 'direct_scene',
      input: { sceneId: scene.id },
    });
    return json({ job }, 202);
  });
}
