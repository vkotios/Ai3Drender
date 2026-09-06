import { apiError, json, withScene } from '@/lib/api';
import { storageKeys } from '@/lib/pipeline/storage-keys';

type Params = { params: Promise<{ sceneId: string }> };

/**
 * Image-only for this first cut (issue #52 Phase A): a rasterised PDF or a
 * DXF's extents would both work as a reference underlay too, but decoding
 * either needs a dependency this app does not otherwise carry (a PDF
 * rasteriser, or even a narrow DXF group-code reader). Scoped out of this
 * pass per the proposal's own bias toward the smallest useful surface - see
 * docs/proposals/cad-floor-plan-import.md and the PR this route shipped in.
 * A photo or scan of a printed plan needs no parser at all and already
 * covers the case the doc calls out as possibly the *only* one that
 * matters for this app's actual customers.
 */
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Upload (or replace) the reference underlay image for a traced floor-plan
 * footprint.
 *
 * Only stores the image and hands back its blob path plus a fetchable URL -
 * the studio then patches `EnvironmentSettings.footprint.underlay` via the
 * ordinary scene PATCH once the user has set its real-world scale, exactly
 * like a material library swatch upload today (see
 * app/api/materials/[materialId]/swatch/route.ts). The scale and the traced
 * polygon itself live in the scene doc, not here - this route only ever
 * moves bytes into storage.
 */
export async function POST(request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, scene) => {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return apiError('No file was uploaded');
    if (!ACCEPTED.includes(file.type)) {
      return apiError(
        `Unsupported type ${file.type || 'unknown'} - upload a PNG or JPEG scan or photo of the floor plan`,
      );
    }
    if (file.size > MAX_BYTES) return apiError(`Larger than ${MAX_BYTES / 1024 / 1024}MB`);

    const extension = file.type.split('/')[1] ?? 'png';
    const path = storageKeys.floorPlan(scene.projectId, extension);
    await store.putBlob(path, new Uint8Array(await file.arrayBuffer()), file.type);

    // Best-effort: drop the underlay image this one is replacing, when the
    // caller names it. Not fatal - an orphaned blob is picked up by
    // scripts/reconcile-storage.ts, not a correctness problem for the scene.
    const previousPath = form.get('previousPath');
    if (typeof previousPath === 'string' && previousPath) {
      await store.deleteBlob(previousPath).catch(() => undefined);
    }

    return json({ path, url: await store.blobUrl(path) }, 201);
  });
}
