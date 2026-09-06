import { apiError, json, withAsset } from '@/lib/api';
import { storageKeys } from '@/lib/pipeline';

type Params = { params: Promise<{ assetId: string; versionId: string }> };

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Cache a small captured PNG of a version's mesh, for list thumbnails.
 *
 * The studio and the workbench both know how to read their own canvas back as
 * a PNG (see lib/studio/export.ts's captureViewport); this is where that
 * capture gets persisted so the next page load does not have to re-render it.
 *
 * A version is frozen the moment it is accepted (accepted_at set, enforced by
 * a trigger in Supabase and mirrored in the local store), so a first capture
 * that loses the race against acceptance cannot be saved. That is treated as
 * a soft failure here: the caller already has the pixels on screen, it just
 * cannot cache them for next time.
 */
export async function POST(request: Request, { params }: Params) {
  const { assetId, versionId } = await params;
  return withAsset(assetId, async ({ store }, asset) => {
    const version = await store.getAssetVersion(versionId);
    if (!version || version.assetId !== asset.id) return apiError('Version not found', 404);
    if (version.previewPath) return json({ persisted: true, path: version.previewPath });

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return apiError('No image was uploaded');
    if (file.size > MAX_BYTES) return apiError('Preview is too large to store');
    if (!file.type.startsWith('image/')) return apiError(`Unsupported type ${file.type}`);

    const path = storageKeys.preview(asset.projectId, version.id);
    await store.putBlob(path, new Uint8Array(await file.arrayBuffer()), file.type);

    try {
      await store.updateAssetVersion(version.id, { previewPath: path });
      return json({ persisted: true, path }, 201);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/immutable/i.test(message)) throw cause;
      // The version was accepted between the capture and this request landing.
      // The blob is written but orphaned; that is harmless and consistent with
      // how every other delete/replace path in this app currently leaves blobs
      // behind (see issue #5).
      return json({ persisted: false, reason: 'version is accepted and immutable' });
    }
  });
}
