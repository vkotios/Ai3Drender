import { apiError, json, withProject } from '@/lib/api';
import { createSceneDoc } from '@/lib/scene/defaults';
import { DEFAULT_PRESET_ID } from '@/lib/scene/presets';

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) => json(await store.listScenes(project.id)));
}

export async function POST(request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) => {
    const body = (await request.json().catch(() => ({}))) as { name?: string; presetId?: string };
    if (body.presetId !== undefined && typeof body.presetId !== 'string') {
      return apiError('presetId must be a string');
    }
    const scene = await store.createScene({
      projectId: project.id,
      name: body.name?.trim() || 'Exhibition stand',
      doc: createSceneDoc(body.presetId ?? DEFAULT_PRESET_ID),
    });
    return json(scene, 201);
  });
}
