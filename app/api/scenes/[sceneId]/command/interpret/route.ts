import { interpretSceneCommand } from '@/lib/ai/gemini';
import { apiError, json, withScene } from '@/lib/api';
import type { VersionLookup } from '@/lib/scene/collisions';
import { migrateSceneOnLoad } from '@/lib/scene/materialOverrides';
import type { MaterialSpec, Uuid } from '@/lib/types';

type Params = { params: Promise<{ sceneId: string }> };

/**
 * Turn one free-text studio command into a list of validated `SceneMutation`s
 * - issue #89's first half of the command bar's now two-step flow.
 *
 * This is read-only: it neither applies the mutations nor saves anything, so
 * it carries no `expectedVersion`/conflict handling of its own. The studio
 * applies the returned mutations to its own in-memory `SceneDoc` immediately
 * (via `applySceneMutations`, same pure function this route itself would
 * otherwise have called) so the result lands in the viewport before any save
 * round trip, then commits through the ordinary `PATCH /api/scenes/:sceneId`
 * save - which still has the usual conflict check, so a command run against a
 * doc that has since moved on under someone else still gets caught there,
 * exactly as a manual edit would be.
 *
 * See `lib/scene/command.ts` for why the mutation set is closed rather than
 * an open-ended agentic tool-use loop.
 */
export async function POST(request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, loaded) => {
    const body = (await request.json().catch(() => ({}))) as { command?: string };
    const command = body.command?.trim();
    if (!command) return apiError('A command is required');

    // Same version-resolution the GET route and the old combined command
    // route both needed: the interpreter needs each node's real spec
    // materials to describe them in the prompt and to resolve "the sofa's
    // cushion".
    const versionIds = [
      ...new Set(loaded.doc.nodes.map((n) => n.assetVersionId).filter((id): id is Uuid => !!id)),
    ];
    const versions: VersionLookup = {};
    const specMaterialsByVersionId = new Map<Uuid, readonly MaterialSpec[]>();
    for (const id of versionIds) {
      const version = await store.getAssetVersion(id);
      if (!version) continue;
      versions[id] = { version };
      specMaterialsByVersionId.set(id, version.spec.materials);
    }

    const scene = await migrateSceneOnLoad(store, loaded, specMaterialsByVersionId);
    const { mutations, unresolved } = await interpretSceneCommand(scene.doc, versions, command);
    return json({ mutations, unresolved });
  });
}
