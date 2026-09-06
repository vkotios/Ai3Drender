import { apiError, json, withScene } from '@/lib/api';
import type { RenderPass } from '@/lib/types';

type Params = { params: Promise<{ sceneId: string }> };

const MAX_DIMENSION = 8192;
const VALID_PASSES: RenderPass[] = ['ao', 'cryptomatte'];

/**
 * Queue an offline Blender/Cycles pass over the current scene.
 *
 * Unlike the path-traced and concept renders, this one needs no upload: the
 * whole scene is already in `scene.doc`, so the stage builds its own glTF
 * from that directly (see lib/render/build-scene.ts).
 */
export async function POST(request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const width = Number(body.width ?? 1920);
    const height = Number(body.height ?? 1080);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return apiError('width and height must be positive numbers');
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return apiError(`width and height must be at most ${MAX_DIMENSION}`);
    }

    const passes = Array.isArray(body.passes)
      ? body.passes.filter((p): p is RenderPass => VALID_PASSES.includes(p as RenderPass))
      : [];

    const job = await store.createJob({
      projectId: scene.projectId,
      kind: 'render',
      input: {
        sceneId: scene.id,
        width: Math.round(width),
        height: Math.round(height),
        samples: body.samples !== undefined ? Number(body.samples) : undefined,
        denoise: body.denoise !== undefined ? Boolean(body.denoise) : undefined,
        passes,
        format: body.format === 'exr' ? 'exr' : 'png',
      },
    });

    return json({ job }, 202);
  });
}
