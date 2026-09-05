'use client';

import type { SceneNode } from '@/lib/types';
import { PROP_DEFINITIONS } from '@/lib/scene/presets';

/**
 * Staging geometry - plinths, rugs, partitions. Simple boxes on purpose: these
 * exist to give the pieces context and scale, not to be products themselves.
 */
export function PropNode({
  node,
  selected,
  onSelect,
}: {
  node: SceneNode;
  selected: boolean;
  onSelect: () => void;
}) {
  if (!node.visible || !node.propKind) return null;
  const definition = PROP_DEFINITIONS[node.propKind];
  const [w, h, d] = definition.size;
  const override = node.materialOverrides.prop;

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
      {/* Boxes are authored centred; lift by half the height to sit on the floor. */}
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow name={definition.label}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial
          color={override?.baseColorHex ?? definition.colorHex}
          roughness={override?.roughness ?? definition.roughness}
          metalness={override?.metalness ?? 0}
        />
      </mesh>
      {selected && (
        <mesh position={[0, h / 2, 0]} userData={{ helper: true }} raycast={() => null}>
          <boxGeometry args={[w * 1.02, h * 1.02, d * 1.02]} />
          <meshBasicMaterial color="#d99b42" wireframe transparent opacity={0.85} />
        </mesh>
      )}
    </group>
  );
}
