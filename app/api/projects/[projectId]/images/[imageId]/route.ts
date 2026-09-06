import { apiError, json, withProject } from '@/lib/api';

type Params = { params: Promise<{ projectId: string; imageId: string }> };

/**
 * Delete one source photograph.
 *
 * Blob cleanup on delete is tracked separately (issue #5); until it lands
 * this only removes the row, and the underlying file is orphaned in storage.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const { projectId, imageId } = await params;
  return withProject(projectId, async ({ store }, project) => {
    const [image] = await store.getSourceImages([imageId]);
    if (!image || image.projectId !== project.id) return apiError('Photograph not found', 404);
    await store.deleteSourceImage(image.id);
    return json({ deleted: true });
  });
}
