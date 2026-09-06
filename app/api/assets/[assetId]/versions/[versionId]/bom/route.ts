import { NextResponse } from 'next/server';

import { apiError, withAsset } from '@/lib/api';
import { bomFilename, bomRowsToCsv, buildBomRows } from '@/lib/bom';
import type { MaterialLibraryEntry } from '@/lib/types';

type Params = { params: Promise<{ assetId: string; versionId: string }> };

/**
 * Export the parts list (bill of materials) for an accepted version, as CSV:
 * one row per spec component, with the material-library entry it is bound to
 * (name and manufacturer code) or a flag that it was never matched to the
 * library, and a quantity inferred the same way the whole-part annotation
 * selection counts instances - see `instanceCountForRole`.
 *
 * Scoped to an accepted version, same reasoning as everywhere else a version
 * is read for something meant to be acted on outside the studio: an
 * in-progress version's components and materials can still change underneath
 * this export, and a parts list is only useful as a frozen snapshot to order
 * against.
 */
export async function GET(_request: Request, { params }: Params) {
  const { assetId, versionId } = await params;
  return withAsset(assetId, async ({ store, viewer }, asset) => {
    const version = await store.getAssetVersion(versionId);
    if (!version || version.assetId !== asset.id) return apiError('Version not found', 404);
    if (!version.acceptedAt) {
      return apiError('Only an accepted version has a frozen parts list to export', 409);
    }

    const libraryEntryIds = Array.from(
      new Set(
        version.spec.materials
          .map((material) => material.libraryEntryId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const fetched = await Promise.all(libraryEntryIds.map((id) => store.getMaterialLibraryEntry(id)));
    const libraryEntries = new Map<string, MaterialLibraryEntry>();
    for (const entry of fetched) {
      // Defensive: the library is account-scoped, so an entry bound onto this
      // viewer's own spec should always be theirs. Skip anything that isn't
      // rather than leaking another account's code into the export.
      if (entry && entry.ownerId === viewer.id) libraryEntries.set(entry.id, entry);
    }

    const rows = buildBomRows(version.spec, libraryEntries);
    const csv = bomRowsToCsv(rows);
    const filename = bomFilename(asset.name || version.spec.displayName, version.versionNumber);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });
}
