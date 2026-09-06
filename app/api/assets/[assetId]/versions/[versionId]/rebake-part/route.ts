import { apiError, json, withAsset } from '@/lib/api';

type Params = { params: Promise<{ assetId: string; versionId: string }> };

interface RebakePartBody {
  /** Exact component/node name ("Legs"), or free text ("the legs"). */
  target?: string;
  /** Bind the part to a library entry's canonical values. */
  libraryEntryId?: string;
  /** Regenerate the part's material from a free-text description, via `correctMaterial`. */
  instruction?: string;
}

/**
 * Re-bake one named part's material into a new asset version, permanently.
 *
 * This is issue #57's counterpart to `PATCH .../materials/:materialId`
 * (issue #48): that route is a synchronous, mesh-untouched spec patch shared
 * by every component bound to the same material entry; this route instead
 * enqueues a `rebake_part` job (mirroring how `POST .../refine` enqueues
 * `refine` rather than doing the work inline) because it has to open the
 * stored .glb, edit only the targeted part's primitives, and write a new mesh
 * blob - real I/O, not a plain object patch. `target` may name the part
 * exactly or describe it in free text; the job resolves it against the
 * piece's named components, with a model-assisted fallback when the two
 * don't match exactly - see `resolveTargetComponent` in lib/pipeline/index.ts.
 *
 * Same two mutually exclusive material sources as the spot-fix route:
 * `libraryEntryId` (bind to a library entry's canonical PBR values) or
 * `instruction` (regenerate from a free-text correction). Ownership of a
 * given `libraryEntryId` is checked here, while it can still be resolved -
 * the job runs under the worker store, which has no signed-in viewer to
 * check it against.
 *
 * No accepted-version guard: unlike the spot-fix, this never mutates the
 * version named in the URL - it always forks a new one, the same as
 * `POST .../refine` is allowed to do off an accepted parent.
 */
export async function POST(request: Request, { params }: Params) {
  const { assetId, versionId } = await params;
  return withAsset(assetId, async ({ store, viewer }, asset) => {
    const version = await store.getAssetVersion(versionId);
    if (!version || version.assetId !== asset.id) return apiError('Version not found', 404);
    if (!version.meshPath) return apiError('This version has no mesh to rebake yet', 409);

    const body = (await request.json().catch(() => ({}))) as RebakePartBody;
    const target = body.target?.trim();
    if (!target) return apiError('Name or describe the part to rebake');

    if (body.libraryEntryId && body.instruction?.trim()) {
      return apiError('Give either libraryEntryId or instruction, not both');
    }

    let materialChange: { libraryEntryId: string } | { instruction: string };
    if (body.libraryEntryId) {
      const candidate = await store.getMaterialLibraryEntry(body.libraryEntryId);
      if (!candidate || candidate.ownerId !== viewer.id) {
        return apiError('Library material not found', 404);
      }
      materialChange = { libraryEntryId: candidate.id };
    } else if (body.instruction?.trim()) {
      materialChange = { instruction: body.instruction.trim() };
    } else {
      return apiError('Either libraryEntryId or instruction is required');
    }

    const job = await store.createJob({
      projectId: asset.projectId,
      assetId: asset.id,
      kind: 'rebake_part',
      input: { versionId: version.id, target, materialChange },
    });

    return json({ job }, 202);
  });
}
