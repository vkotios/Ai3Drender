import { apiError, json, withSession } from '@/lib/api';
import { requireProject } from '@/lib/db';
import type { AnnotationStatus } from '@/lib/types';

type Params = { params: Promise<{ annotationId: string }> };

/**
 * Annotations are addressed by their own id, so ownership is walked back
 * through the asset to the project on every call.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { annotationId } = await params;
  const patch = (await request.json()) as { body?: string; status?: AnnotationStatus };

  return withSession(async (session) => {
    const annotation = await session.store.getAnnotation(annotationId);
    if (!annotation) return apiError('Note not found', 404);

    const asset = await session.store.getAsset(annotation.assetId);
    if (!asset || !(await requireProject(session, asset.projectId))) {
      return apiError('Note not found', 404);
    }

    return json(await session.store.updateAnnotation(annotation.id, patch));
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { annotationId } = await params;
  return withSession(async (session) => {
    const annotation = await session.store.getAnnotation(annotationId);
    if (!annotation) return apiError('Note not found', 404);

    const asset = await session.store.getAsset(annotation.assetId);
    if (!asset || !(await requireProject(session, asset.projectId))) {
      return apiError('Note not found', 404);
    }

    await session.store.deleteAnnotation(annotation.id);
    return json({ deleted: true });
  });
}
