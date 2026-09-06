import { json, withMaterialLibraryEntry } from '@/lib/api';

type Params = { params: Promise<{ materialId: string }> };

/**
 * Every piece bound to this material, across every project the caller owns -
 * what a discontinued fabric would actually affect.
 */
export async function GET(_request: Request, { params }: Params) {
  const { materialId } = await params;
  return withMaterialLibraryEntry(materialId, async ({ store }, entry) =>
    json(await store.listMaterialLibraryUsage(entry.ownerId, entry.id)),
  );
}
