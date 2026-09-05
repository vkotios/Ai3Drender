import { apiError, json, withScene } from '@/lib/api';
import { storageKeys } from '@/lib/pipeline';

type Params = { params: Promise<{ sceneId: string }> };

const MAX_BYTES = 30 * 1024 * 1024;

export async function GET(_request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    const renders = await store.listSceneRenders(scene.id);
    return json(
      await Promise.all(
        renders.map(async (render) => ({ ...render, url: await store.blobUrl(render.path) })),
      ),
    );
  });
}

/** Store a frame the browser path-traced. */
export async function POST(request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return apiError('No image was uploaded');
    if (file.size > MAX_BYTES) return apiError('Render is too large to store');
    if (!file.type.startsWith('image/')) return apiError(`Unsupported type ${file.type}`);

    const path = storageKeys.render(scene.projectId, scene.id, 'pathtraced', 'png');
    await store.putBlob(path, new Uint8Array(await file.arrayBuffer()), file.type);

    const render = await store.createSceneRender({
      sceneId: scene.id,
      projectId: scene.projectId,
      kind: 'pathtraced',
      path,
      width: Number(form.get('width') ?? 0),
      height: Number(form.get('height') ?? 0),
      // The tracer counts fractional samples while warming up, but this is
      // stored as an integer.
      samples: form.get('samples') ? Math.round(Number(form.get('samples'))) : null,
      prompt: null,
    });

    return json({ ...render, url: await store.blobUrl(render.path) }, 201);
  });
}
