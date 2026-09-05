'use client';

import { useGLTF } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';

import type { AssetVersion, SceneNode } from '@/lib/types';

/**
 * One reconstructed furniture piece in the scene.
 *
 * Two things have to happen to a vendor mesh before it can share a scene with
 * anything else: it must be scaled to real-world size, and it must be grounded
 * so its lowest point sits on y=0 rather than wherever the vendor's origin fell.
 */
export function AssetNode({
  node,
  version,
  meshUrl,
  selected,
  onSelect,
}: {
  node: SceneNode;
  version: AssetVersion;
  meshUrl: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { scene } = useGLTF(meshUrl);

  const prepared = useMemo(() => {
    // Clone so several nodes can reference the same version, and so material
    // overrides on one instance do not leak into the others.
    const root = scene.clone(true);
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      child.material = Array.isArray(child.material)
        ? child.material.map((m) => m.clone())
        : child.material.clone();
    });

    // Measure before any scaling so the numbers are in the mesh's own units.
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const longestAxis = Math.max(size.x, size.y, size.z) || 1;

    const targetLongestM =
      Math.max(
        version.spec.dimensions.widthMm,
        version.spec.dimensions.depthMm,
        version.spec.dimensions.heightMm,
      ) / 1000;

    // meshExtentMm set means the provider already returned real-world units
    // (the massing generator does); null means unit-normalised, so fit it to
    // the dimensions the vision pass derived.
    const fit = version.meshExtentMm === null ? targetLongestM / longestAxis : 1;

    const center = box.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(-center.x * fit, -box.min.y * fit, -center.z * fit);

    return { root, fit, offset };
  }, [scene, version.meshExtentMm, version.spec.dimensions]);

  // Material overrides are keyed by the material name as it appears in the
  // mesh, which is what the spec's material names map to for our own output.
  useMemo(() => {
    prepared.root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        const override = node.materialOverrides[material.name];
        if (!override || !(material instanceof THREE.MeshStandardMaterial)) continue;
        if (override.baseColorHex) material.color.set(override.baseColorHex);
        if (override.roughness !== undefined) material.roughness = override.roughness;
        if (override.metalness !== undefined) material.metalness = override.metalness;
        material.needsUpdate = true;
      }
    });
  }, [prepared.root, node.materialOverrides]);

  if (!node.visible) return null;

  return (
    <group
      position={[node.transform.position.x, node.transform.position.y, node.transform.position.z]}
      rotation={[node.transform.rotation.x, node.transform.rotation.y, node.transform.rotation.z]}
      scale={[node.transform.scale.x, node.transform.scale.y, node.transform.scale.z]}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      userData={{ nodeId: node.id, exportable: true }}
    >
      <group position={prepared.offset} scale={prepared.fit}>
        <primitive object={prepared.root} />
      </group>
      {selected && <SelectionBox object={prepared.root} scale={prepared.fit} offset={prepared.offset} />}
    </group>
  );
}

/** A wireframe cage around the selection. Excluded from export via userData. */
function SelectionBox({
  object,
  scale,
  offset,
}: {
  object: THREE.Object3D;
  scale: number;
  offset: THREE.Vector3;
}) {
  const geometry = useMemo(() => {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3()).multiplyScalar(scale);
    const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale).add(offset);
    const geo = new THREE.BoxGeometry(size.x * 1.02, size.y * 1.02, size.z * 1.02);
    geo.translate(center.x, center.y, center.z);
    return geo;
  }, [object, scale, offset]);

  return (
    <lineSegments userData={{ helper: true }} raycast={() => null}>
      <edgesGeometry args={[geometry]} />
      <lineBasicMaterial color="#d99b42" transparent opacity={0.9} />
    </lineSegments>
  );
}
