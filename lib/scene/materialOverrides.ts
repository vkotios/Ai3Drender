import type { Store } from '@/lib/db/store';
import type { MaterialSpec, Scene, SceneDoc, SceneNode, Uuid } from '@/lib/types';

/**
 * Per-scene material overrides used to be keyed by `MaterialSpec.name`. That
 * broke as soon as a refinement round changed a material's display name
 * without changing its id: the override key no longer matched anything, and
 * the piece silently reverted to the spec colour with no error (issue #7).
 *
 * Overrides are now keyed by `MaterialSpec.id`, which a refinement is not
 * expected to change. This module resolves that key at apply/edit time and
 * migrates documents written under the old scheme.
 */

/**
 * Which key in `node.materialOverrides` applies to a mesh material named
 * `meshMaterialName`, given the spec of the version the node currently loads.
 *
 * Prefers the id of whichever spec material currently carries that name. Our
 * own massing meshes (`lib/ai/mesh/massing.ts`) always name a material after
 * the spec entry it was built from, so this is exact for them. Only when the
 * mesh's material name matches no material in the current spec - a
 * vendor-reconstructed mesh whose names we do not control, or a mesh baked
 * from a since-renamed spec - do we fall back to the raw name itself, which
 * keeps old vendor-mesh overrides (keyed by whatever name the vendor used)
 * working exactly as before.
 */
export function resolveMaterialOverrideKey(
  meshMaterialName: string,
  specMaterials: readonly MaterialSpec[],
): string {
  return specMaterials.find((m) => m.name === meshMaterialName)?.id ?? meshMaterialName;
}

/** True when `key` is a material id in the given spec, i.e. already migrated. */
function isCurrentId(key: string, specMaterials: readonly MaterialSpec[]): boolean {
  return specMaterials.some((m) => m.id === key);
}

/**
 * Rekey one node's overrides from the pre-fix "material name" scheme onto
 * `MaterialSpec.id`, using the spec of the version it currently points at.
 *
 * A key already equal to a live material id (already migrated, or a
 * coincidence) passes through untouched, and so does the prop node's `"prop"`
 * key. A key that matches neither a current id nor a current name is *kept*
 * rather than dropped - it targets a material that no longer exists under any
 * name we can find (removed by a refinement, or renamed before this fix
 * shipped so the old name is already lost), and the Inspector surfaces
 * anything like that to the user instead of it just vanishing.
 */
function migrateNode(node: SceneNode, specMaterials: readonly MaterialSpec[] | undefined): SceneNode {
  if (node.kind !== 'asset' || !specMaterials || Object.keys(node.materialOverrides).length === 0) {
    return node;
  }

  const idByName = new Map(specMaterials.map((m) => [m.name, m.id]));
  let changed = false;
  const next: SceneNode['materialOverrides'] = {};

  for (const [key, override] of Object.entries(node.materialOverrides)) {
    if (isCurrentId(key, specMaterials)) {
      next[key] = { ...next[key], ...override };
      continue;
    }
    const matchedId = idByName.get(key);
    if (matchedId) {
      changed = true;
      next[matchedId] = { ...next[matchedId], ...override };
      continue;
    }
    next[key] = { ...next[key], ...override };
  }

  return changed ? { ...node, materialOverrides: next } : node;
}

/**
 * Rekey every node in a scene document. Pass the spec materials of every
 * asset version the document references, keyed by version id - callers
 * already load those versions to resolve mesh URLs, so this asks for the
 * slice it needs rather than a store handle.
 */
export function migrateSceneMaterialOverrides(
  doc: SceneDoc,
  specMaterialsByVersionId: ReadonlyMap<Uuid, readonly MaterialSpec[]>,
): { doc: SceneDoc; changed: boolean } {
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    const specMaterials = node.assetVersionId
      ? specMaterialsByVersionId.get(node.assetVersionId)
      : undefined;
    const migrated = migrateNode(node, specMaterials);
    if (migrated !== node) changed = true;
    return migrated;
  });
  return changed ? { doc: { ...doc, nodes }, changed: true } : { doc, changed: false };
}

/**
 * Load-time migration: rekey a scene's legacy name-keyed overrides and
 * persist the result once, so the rewrite only happens the first time a
 * pre-fix scene is opened after this shipped. A no-op (and no write) when the
 * scene has nothing to rekey.
 */
export async function migrateSceneOnLoad(
  store: Store,
  scene: Scene,
  specMaterialsByVersionId: ReadonlyMap<Uuid, readonly MaterialSpec[]>,
): Promise<Scene> {
  const { doc, changed } = migrateSceneMaterialOverrides(scene.doc, specMaterialsByVersionId);
  if (!changed) return scene;
  return store.updateScene(scene.id, { doc }, 'migrate material overrides to id keys');
}

/**
 * Overrides on a node that target neither a live material id nor `"prop"`.
 * Used by the Inspector to flag - rather than silently discard - overrides
 * whose material no longer exists under any name it can find.
 */
export function orphanedOverrideKeys(node: SceneNode, specMaterials: readonly MaterialSpec[]): string[] {
  if (node.kind !== 'asset') return [];
  return Object.keys(node.materialOverrides).filter((key) => !isCurrentId(key, specMaterials));
}
