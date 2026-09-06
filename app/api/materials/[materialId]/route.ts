import { apiError, json, withMaterialLibraryEntry } from '@/lib/api';
import type { MaterialLibraryEntryPatch } from '@/lib/db/store';
import { isHex, isMaterialKind, isUnit } from '@/lib/materials';

type Params = { params: Promise<{ materialId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { materialId } = await params;
  return withMaterialLibraryEntry(materialId, async (_session, entry) => json(entry));
}

interface UpdateBody {
  name?: string;
  code?: string | null;
  kind?: string;
  baseColorHex?: string;
  roughness?: number;
  metalness?: number;
  sheen?: number;
  clearcoat?: number;
  finish?: string;
  notes?: string;
  /** true to discontinue, false to bring back into circulation. */
  archived?: boolean;
}

export async function PATCH(request: Request, { params }: Params) {
  const { materialId } = await params;
  return withMaterialLibraryEntry(materialId, async ({ store }, entry) => {
    const body = (await request.json()) as UpdateBody;
    const patch: MaterialLibraryEntryPatch = {};

    if (body.name !== undefined) {
      if (!body.name.trim()) return apiError('name cannot be empty');
      patch.name = body.name.trim();
    }
    if (body.code !== undefined) patch.code = body.code?.trim() || null;
    if (body.kind !== undefined) {
      if (!isMaterialKind(body.kind)) return apiError('kind must be a valid material kind');
      patch.kind = body.kind;
    }
    if (body.baseColorHex !== undefined) {
      if (!isHex(body.baseColorHex)) return apiError('baseColorHex must be a CSS hex colour');
      patch.baseColorHex = body.baseColorHex;
    }
    for (const field of ['roughness', 'metalness', 'sheen', 'clearcoat'] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (!isUnit(value)) return apiError(`${field} must be a number between 0 and 1`);
      patch[field] = value;
    }
    if (body.finish !== undefined) patch.finish = body.finish.trim();
    if (body.notes !== undefined) patch.notes = body.notes.trim();
    if (body.archived !== undefined) {
      patch.archivedAt = body.archived ? new Date().toISOString() : null;
    }

    return json(await store.updateMaterialLibraryEntry(entry.id, patch));
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { materialId } = await params;
  return withMaterialLibraryEntry(materialId, async ({ store }, entry) => {
    const usage = await store.listMaterialLibraryUsage(entry.ownerId, entry.id);
    if (usage.length > 0) {
      return apiError(
        `${entry.name} is bound to ${usage.length} piece(s); archive it instead of deleting so ` +
          'those bindings stay traceable',
        409,
      );
    }
    await store.deleteMaterialLibraryEntry(entry.id);
    return json({ deleted: true });
  });
}
