/**
 * Re-bake one named part's material directly into a stored .glb, leaving
 * every other part's geometry and material bitwise-identical (issue #57).
 *
 * This is the permanent counterpart to the material spot-fix (issue #48),
 * which only patches `FurnitureSpec.materials` - descriptive PBR values that
 * a real vendor mesh's own baked appearance need not track at all - and to
 * `SceneNode.materialOverrides` (issue #7), a viewer-side tweak that never
 * touches the stored mesh. Both of those are cheap precisely because they
 * never open the .glb; this does, but only to touch the primitives that
 * belong to the targeted part.
 *
 * Matching follows the same convention `lib/scene/materialOverrides.ts` and
 * `lib/scene/anchor.ts` already rely on: our own massing/reconstruction
 * output names every mesh (and the node that instances it) after the spec
 * component it came from, with a trailing instance number stripped by
 * `baseName` for a part that expands to several boxes (e.g. "Legs 1".."Legs
 * 4"). A vendor mesh whose node names don't happen to match any requested
 * part name simply matches nothing here - see `matchedNames` on the result.
 */
import { Document, type Material, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';

import { baseName } from '@/lib/scene/anchor';

import { hexToRgb } from './glb';

export interface RebakeMaterialValues {
  name: string;
  baseColorHex: string;
  /** 0 = mirror, 1 = fully diffuse - same convention as `MaterialSpec.roughness`. */
  roughness: number;
  /** 0 = dielectric, 1 = raw metal - same convention as `MaterialSpec.metalness`. */
  metalness: number;
}

export interface RebakePartResult {
  /** The rebaked .glb. Identical to the input when nothing matched. */
  glb: Uint8Array;
  /** Node/mesh names actually repainted, e.g. ["Legs 1", "Legs 2", "Legs 3", "Legs 4"]. */
  matchedNames: string[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Repaint every primitive belonging to a node or mesh whose base name (see
 * `baseName`) case-insensitively matches one of `targetBaseNames`.
 *
 * A material is cloned before it is changed, and only for primitives that
 * actually match - so a material shared with an untargeted part is left
 * completely alone on that part, while every matched primitive that shared
 * it moves onto one new clone together (still shared amongst themselves,
 * just no longer with what wasn't targeted). `prune` then drops the original
 * material (and any texture only it used) if the rebake left it unreferenced.
 */
export async function rebakePartMaterial(
  glb: Uint8Array,
  targetBaseNames: string[],
  material: RebakeMaterialValues,
): Promise<RebakePartResult> {
  const targets = new Set(targetBaseNames.map((n) => baseName(n).toLowerCase()).filter(Boolean));
  if (targets.size === 0) return { glb, matchedNames: [] };

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document: Document = await io.readBinary(glb);

  const matchedNames = new Set<string>();
  const cloneOf = new Map<Material, Material>();

  for (const scene of document.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;

      const ownName = node.getName() || mesh.getName();
      if (!targets.has(baseName(ownName).toLowerCase())) return;
      matchedNames.add(ownName);

      for (const primitive of mesh.listPrimitives()) {
        const original = primitive.getMaterial();
        if (!original) continue;
        let clone = cloneOf.get(original);
        if (!clone) {
          clone = original.clone();
          cloneOf.set(original, clone);
        }
        primitive.setMaterial(clone);
      }
    });
  }

  if (matchedNames.size === 0) return { glb, matchedNames: [] };

  const [r, g, b] = hexToRgb(material.baseColorHex);
  for (const clone of cloneOf.values()) {
    clone.setName(material.name);
    // Alpha is preserved from whatever the source material had; only the
    // colour, roughness and metalness are this feature's to change - the same
    // three PBR channels `lib/ai/mesh/massing.ts` itself bakes into a glTF
    // material, so a rebaked stub-provider mesh renders exactly as a freshly
    // generated one would with this material bound to the part.
    clone.setBaseColorFactor([r, g, b, clone.getBaseColorFactor()[3]]);
    clone.setRoughnessFactor(clamp01(material.roughness));
    clone.setMetallicFactor(clamp01(material.metalness));
    // A solid rebaked colour must not be multiplied by whatever texture the
    // part previously baked - otherwise the new factor only tints the old
    // photo-derived texture instead of replacing its appearance outright.
    clone.setBaseColorTexture(null);
    clone.setMetallicRoughnessTexture(null);
  }

  await document.transform(prune({ propertyTypes: ['Material', 'Texture'] }));

  return { glb: await io.writeBinary(document), matchedNames: [...matchedNames] };
}
