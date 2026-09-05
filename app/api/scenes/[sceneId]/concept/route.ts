import { apiError, json, withScene } from '@/lib/api';
import { hasGemini } from '@/lib/env';
import { storageKeys } from '@/lib/pipeline';

type Params = { params: Promise<{ sceneId: string }> };

const MAX_BYTES = 30 * 1024 * 1024;

/**
 * Queue a fast photoreal pass over a viewport capture.
 *
 * The capture is stored first and the work is queued, so a slow image model
 * cannot hold the request open. The stored capture is deleted by the stage
 * once it has been used.
 */
export async function POST(request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    if (!hasGemini) {
      return apiError('Concept renders need GEMINI_API_KEY to be set', 400);
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return apiError('No viewport capture was uploaded');
    if (file.size > MAX_BYTES) return apiError('Capture is too large');
    if (!file.type.startsWith('image/')) return apiError(`Unsupported type ${file.type}`);

    const capturePath = storageKeys.render(scene.projectId, scene.id, 'capture', 'png');
    await store.putBlob(capturePath, new Uint8Array(await file.arrayBuffer()), file.type);

    const job = await store.createJob({
      projectId: scene.projectId,
      kind: 'concept_render',
      input: {
        sceneId: scene.id,
        capturePath,
        instruction: (form.get('instruction') as string) || null,
        width: Number(form.get('width') ?? 0),
        height: Number(form.get('height') ?? 0),
      },
    });

    return json({ job }, 202);
  });
}
