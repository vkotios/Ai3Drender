import * as THREE from 'three';

import { resolveMaterialOverrideKey } from '@/lib/scene/materialOverrides';
import type { MaterialSpec, SceneNode } from '@/lib/types';

/**
 * Apply a node's material overrides to every mesh material under `root`,
 * matching `MaterialSpec.id` the same way `components/studio/AssetNode.tsx`
 * does for the live viewport - shared so `lib/studio/export.ts` can reproduce
 * the same colours on a freshly loaded full-detail mesh it swaps in at
 * export time (see issue #47), rather than exporting the vendor defaults.
 */
export function applyMaterialOverrides(
  root: THREE.Object3D,
  materialOverrides: SceneNode['materialOverrides'],
  specMaterials: readonly MaterialSpec[],
): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      const key = resolveMaterialOverrideKey(material.name, specMaterials);
      const override = materialOverrides[key];
      if (!override || !(material instanceof THREE.MeshStandardMaterial)) continue;
      if (override.baseColorHex) material.color.set(override.baseColorHex);
      if (override.roughness !== undefined) material.roughness = override.roughness;
      if (override.metalness !== undefined) material.metalness = override.metalness;
      material.needsUpdate = true;
    }
  });
}
