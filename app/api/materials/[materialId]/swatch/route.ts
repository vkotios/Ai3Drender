import { apiError, json, withMaterialLibraryEntry } from '@/lib/api';
import { librarySwatchKey } from '@/lib/materials';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const MAX_BYTES = 10 * 1024 * 1024;

type Params = { params: Promise<{ materialId: string }> };

/** Upload (or replace) a reference swatch photo for a library entry. */
export async function POST(request: Request, { params }: Params) {
  const { materialId } = await params;
  return withMaterialLibraryEntry(materialId, async ({ store }, entry) => {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return apiError('No file was uploaded');
    if (!ACCEPTED.includes(file.type)) return apiError(`Unsupported type ${file.type || 'unknown'}`);
    if (file.size > MAX_BYTES) return apiError(`Larger than ${MAX_BYTES / 1024 / 1024}MB`);

    const previous = entry.swatchPath;
    const extension = file.type.split('/')[1] ?? 'jpg';
    const path = librarySwatchKey(entry.ownerId, extension);
    await store.putBlob(path, new Uint8Array(await file.arrayBuffer()), file.type);

    const updated = await store.updateMaterialLibraryEntry(entry.id, { swatchPath: path });
    if (previous) await store.deleteBlob(previous).catch(() => undefined);

    return json({ ...updated, swatchUrl: await store.blobUrl(path) }, 201);
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { materialId } = await params;
  return withMaterialLibraryEntry(materialId, async ({ store }, entry) => {
    if (entry.swatchPath) await store.deleteBlob(entry.swatchPath).catch(() => undefined);
    return json(await store.updateMaterialLibraryEntry(entry.id, { swatchPath: null }));
  });
}
