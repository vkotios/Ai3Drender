import { apiError, json, withSession } from '@/lib/api';
import { isHex, isMaterialKind, isUnit } from '@/lib/materials';
import type { NewMaterialLibraryEntry } from '@/lib/db/store';

/** The account's material library. */
export async function GET(request: Request) {
  return withSession(async (session) => {
    const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
    return json(
      await session.store.listMaterialLibraryEntries(session.viewer.id, { includeArchived }),
    );
  });
}

interface CreateBody {
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
}

export async function POST(request: Request) {
  return withSession(async (session) => {
    const body = (await request.json()) as CreateBody;

    if (!body.name?.trim()) return apiError('name is required');
    if (!isMaterialKind(body.kind)) return apiError('kind must be a valid material kind');
    if (!isHex(body.baseColorHex)) return apiError('baseColorHex must be a CSS hex colour');
    for (const [field, value] of [
      ['roughness', body.roughness],
      ['metalness', body.metalness],
      ['sheen', body.sheen ?? 0],
      ['clearcoat', body.clearcoat ?? 0],
    ] as const) {
      if (!isUnit(value)) return apiError(`${field} must be a number between 0 and 1`);
    }

    const input: NewMaterialLibraryEntry = {
      ownerId: session.viewer.id,
      name: body.name.trim(),
      code: body.code?.trim() || null,
      kind: body.kind,
      baseColorHex: body.baseColorHex,
      roughness: body.roughness!,
      metalness: body.metalness!,
      sheen: body.sheen ?? 0,
      clearcoat: body.clearcoat ?? 0,
      finish: body.finish?.trim() ?? '',
      notes: body.notes?.trim() ?? '',
      swatchPath: null,
      archivedAt: null,
    };

    return json(await session.store.createMaterialLibraryEntry(input), 201);
  });
}
