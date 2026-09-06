import { interpretSceneCommand } from '@/lib/ai/gemini';
import { apiError, json, withScene } from '@/lib/api';
import { SceneConflictError } from '@/lib/db/store';
import type { VersionLookup } from '@/lib/scene/collisions';
import { applySceneMutations } from '@/lib/scene/command';
import { migrateSceneOnLoad } from '@/lib/scene/materialOverrides';
import type { MaterialSpec, Uuid } from '@/lib/types';

type Params = { params: Promise<{ sceneId: string }> };

/**
 * Turn one free-text studio command into a small, bounded set of concrete
 * scene mutations and save them - issue #60's "natural-language control of
 * the staged scene", scoped to the app's own operator rather than an
 * external-agent/MCP integration (see the issue and PR description).
 *
 * Deliberately a single request/response round trip, not a job: unlike
 * `direct_scene` (which re-art-directs the whole booth and can take a while),
 * interpreting and applying a bounded set of mutations is fast enough to do
 * inline, and the operator gets an immediate, or immediately-rejected,
 * result.
 */
export async function POST(request: Request, { params }: Params) {
  const { sceneId } = await params;
  return withScene(sceneId, async ({ store }, loaded) => {
    const body = (await request.json().catch(() => ({}))) as {
      command?: string;
      /** The `version` this command was issued against - see `SceneConflictError`. */
      expectedVersion?: number;
    };
    const command = body.command?.trim();
    if (!command) return apiError('A command is required');

    // Resolve every asset version the scene references, same as GET - the
    // interpreter needs each node's real spec materials to describe them in
    // the prompt and to resolve "the sofa's cushion", and `applySceneMutations`
    // needs the same map to know which materialOverrides key a material name
    // resolves to.
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

    // Rekey any material overrides still written under the pre-fix "material
    // name" scheme (issue #7) before interpreting or applying a command
    // against them - same migration the GET route runs on load.
    const scene = await migrateSceneOnLoad(store, loaded, specMaterialsByVersionId);

    const { mutations, unresolved } = await interpretSceneCommand(scene.doc, versions, command);
    const applied = applySceneMutations(scene.doc, mutations, versions);
    const notes = [...unresolved, ...applied.problems];

    if (applied.changes.length === 0) {
      return json({
        scene,
        summary: 'Nothing in that command could be applied.',
        unresolved: notes,
      });
    }

    try {
      const updated = await store.updateScene(
        scene.id,
        { doc: applied.doc },
        `command: ${command}`,
        body.expectedVersion,
      );
      return json({ scene: updated, summary: applied.changes.join(' '), unresolved: notes });
    } catch (cause) {
      if (cause instanceof SceneConflictError) {
        return json(
          {
            error:
              'Someone else saved changes to this scene since you loaded it. Reload to see them, then try the command again.',
            current: cause.current,
          },
          409,
        );
      }
      throw cause;
    }
  });
}
