import { apiError, json, withProject } from '@/lib/api';
import { storageKeys } from '@/lib/pipeline/storage-keys';

type Params = { params: Promise<{ projectId: string }> };

/**
 * Image-only, same narrowing as the existing per-scene floor-plan underlay
 * upload (see app/api/scenes/[sceneId]/floorplan/route.ts's own comment for
 * why a rasterised PDF or DXF extents are out of scope here too).
 */
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * One-click floor-plan-to-scene generation (issue #58): upload a floor-plan
 * image and get back a queued `floorplan_scene` job that builds a whole new,
 * populated stand from it - a traced boundary plus staged furniture - see
 * `lib/pipeline/index.ts`'s `runGenerateSceneFromFloorPlan`.
 *
 * Async, like `analyze`/`reconstruct`, rather than a synchronous round trip
 * the way `POST .../command` is: this makes a vision call over the image
 * plus placement resolution, worth polling for exactly the way the rest of
 * the reconstruction pipeline already is - see `ProjectWorkbench.tsx`'s job
 * polling.
 *
 * Distinct from #52's manual flow (`POST /api/scenes/:sceneId/floorplan`),
 * which only ever stores a reference image against an EXISTING scene for the
 * operator to trace by hand: this route has no scene yet - it creates one -
 * so it lives under the project, not under a scene.
 *
 * `imageWidthPx`/`imageHeightPx` are the uploaded file's own natural pixel
 * dimensions, read client-side before the upload (see `readImageDimensions`
 * in lib/studio/imageDimensions.ts) - the same value a manual underlay
 * upload computes to keep its aspect ratio, reused here rather than adding a
 * server-side image decoder just to read two numbers the browser already
 * has for free.
 */
export async function POST(request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) => {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return apiError('No file was uploaded');
    if (!ACCEPTED.includes(file.type)) {
      return apiError(
        `Unsupported type ${file.type || 'unknown'} - upload a PNG or JPEG scan or photo of the floor plan`,
      );
    }
    if (file.size > MAX_BYTES) return apiError(`Larger than ${MAX_BYTES / 1024 / 1024}MB`);

    const imageWidthPx = Number(form.get('imageWidthPx'));
    const imageHeightPx = Number(form.get('imageHeightPx'));
    if (
      !Number.isFinite(imageWidthPx) ||
      imageWidthPx <= 0 ||
      !Number.isFinite(imageHeightPx) ||
      imageHeightPx <= 0
    ) {
      return apiError('imageWidthPx and imageHeightPx are required and must be positive numbers');
    }

    const sceneNameField = form.get('sceneName');
    const sceneName = typeof sceneNameField === 'string' ? sceneNameField.trim() : '';

    const extension = file.type.split('/')[1] ?? 'png';
    const path = storageKeys.floorPlan(project.id, extension);
    await store.putBlob(path, new Uint8Array(await file.arrayBuffer()), file.type);

    const job = await store.createJob({
      projectId: project.id,
      kind: 'floorplan_scene',
      input: {
        floorPlanPath: path,
        imageWidthPx,
        imageHeightPx,
        ...(sceneName ? { sceneName } : {}),
      },
    });
    return json({ job }, 202);
  });
}
