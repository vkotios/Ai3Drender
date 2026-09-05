import { apiError, json, withProject } from '@/lib/api';
import { storageKeys } from '@/lib/pipeline';
import type { SourceImageRole } from '@/lib/types';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const MAX_BYTES = 20 * 1024 * 1024;

type Params = { params: Promise<{ projectId: string }> };

/** Multipart upload of one or more furniture photographs. */
export async function POST(request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) => {
    const form = await request.formData();
    const files = form.getAll('files').filter((f): f is File => f instanceof File);
    if (files.length === 0) return apiError('No files were uploaded');

    const role = (form.get('role') as SourceImageRole) ?? 'primary';
    const saved = [];

    for (const file of files) {
      if (!ACCEPTED.includes(file.type)) {
        return apiError(`${file.name}: unsupported type ${file.type || 'unknown'}`);
      }
      if (file.size > MAX_BYTES) {
        return apiError(`${file.name}: larger than ${MAX_BYTES / 1024 / 1024}MB`);
      }
      const extension = file.type.split('/')[1] ?? 'jpg';
      const path = storageKeys.source(project.id, extension);
      await store.putBlob(path, new Uint8Array(await file.arrayBuffer()), file.type);
      saved.push(
        await store.addSourceImage({
          projectId: project.id,
          path,
          filename: file.name,
          mimeType: file.type,
          byteSize: file.size,
          role,
        }),
      );
    }

    return json(saved, 201);
  });
}

export async function GET(_request: Request, { params }: Params) {
  const { projectId } = await params;
  return withProject(projectId, async ({ store }, project) =>
    json(await store.listSourceImages(project.id)),
  );
}
