'use client';

import { Html, useGLTF } from '@react-three/drei';
import { useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

import { resolveMaterialOverrideKey } from '@/lib/scene/materialOverrides';
import type { Annotation, AssetVersion, SceneNode } from '@/lib/types';
import type { PendingPin, StudioMode } from '@/lib/studio/store';

import { MeshUrlBoundary } from './MeshUrlBoundary';

interface AssetNodeProps {
  node: SceneNode;
  version: AssetVersion;
  /** Storage key the mesh URL was resolved from - what a refresh re-resolves. */
  meshPath: string;
  meshUrl: string;
  /** Null in local-disk mode: that URL is stable and never needs refreshing. */
  meshUrlExpiresAt: string | null;
  selected: boolean;
  mode: StudioMode;
  annotations: Annotation[];
  pendingPin: PendingPin | null;
  selectedAnnotationId: string | null;
  onSelect: () => void;
  onPin: (pin: Omit<PendingPin, 'nodeId' | 'assetId' | 'assetVersionId'>) => void;
  onSelectAnnotation: (id: string) => void;
}

/**
 * One reconstructed furniture piece in the scene.
 *
 * Wraps the actual mesh in `MeshUrlBoundary` so a signed mesh URL resolved
 * when the page rendered gets refreshed before it goes stale (and retried
 * once if it is ever used past that anyway), rather than staying good for
 * only as long as its one-hour signature - see that component for why.
 */
export function AssetNode({ meshPath, meshUrl, meshUrlExpiresAt, ...rest }: AssetNodeProps) {
  return (
    <MeshUrlBoundary meshKey={meshPath} initialUrl={meshUrl} initialExpiresAt={meshUrlExpiresAt}>
      {(url) => <AssetMesh {...rest} meshUrl={url} />}
    </MeshUrlBoundary>
  );
}

/**
 * The actual mesh, scaled and grounded.
 *
 * Two things have to happen to a vendor mesh before it can share a scene with
 * anything else: it must be scaled to real-world size, and it must be grounded
 * so its lowest point sits on y=0 rather than wherever the vendor's origin fell.
 */
function AssetMesh({
  node,
  version,
  meshUrl,
  selected,
  mode,
  annotations,
  pendingPin,
  selectedAnnotationId,
  onSelect,
  onPin,
  onSelectAnnotation,
}: Omit<AssetNodeProps, 'meshPath' | 'meshUrlExpiresAt'>) {
  const { scene } = useGLTF(meshUrl);
  const groupRef = useRef<THREE.Group>(null);

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

  // Material overrides are keyed by MaterialSpec.id, which survives a
  // refinement renaming the material - the mesh's own material name does not.
  // Resolve each mesh material back to the spec id that currently carries its
  // name, and only fall back to the raw mesh name when nothing in the spec
  // matches it (a vendor mesh whose material names we do not control).
  useMemo(() => {
    prepared.root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        const key = resolveMaterialOverrideKey(material.name, version.spec.materials);
        const override = node.materialOverrides[key];
        if (!override || !(material instanceof THREE.MeshStandardMaterial)) continue;
        if (override.baseColorHex) material.color.set(override.baseColorHex);
        if (override.roughness !== undefined) material.roughness = override.roughness;
        if (override.metalness !== undefined) material.metalness = override.metalness;
        material.needsUpdate = true;
      }
    });
  }, [prepared.root, node.materialOverrides, version.spec.materials]);

  /**
   * A click either selects the piece or pins a note to the exact spot.
   *
   * The anchor is converted into THIS group's local space, which is the frame
   * the inner group's offset and fit map the raw mesh into: metres, origin on
   * the floor at the footprint centre. Storing it there means the note stays
   * put when the piece is moved, rotated or restaged, and stays meaningful if
   * the mesh is later rebuilt at a different vendor scale.
   */
  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();

    if (mode !== 'comment') {
      onSelect();
      return;
    }

    const group = groupRef.current;
    if (!group) return;

    const point = group.worldToLocal(event.point.clone());

    const worldNormal = event.face
      ? event.face.normal.clone().transformDirection(event.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    const normal = worldNormal
      .applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()).invert())
      .normalize();

    onPin({
      point: { x: point.x, y: point.y, z: point.z },
      normal: { x: normal.x, y: normal.y, z: normal.z },
      // Our massing meshes name each part after its component; vendor meshes
      // may not, in which case the server falls back to a positional description.
      partName: event.object.name || null,
    });
  };

  if (!node.visible) return null;

  return (
    <group
      ref={groupRef}
      position={[node.transform.position.x, node.transform.position.y, node.transform.position.z]}
      rotation={[node.transform.rotation.x, node.transform.rotation.y, node.transform.rotation.z]}
      scale={[node.transform.scale.x, node.transform.scale.y, node.transform.scale.z]}
      onClick={handleClick}
      userData={{ nodeId: node.id, exportable: true }}
    >
      <group position={prepared.offset} scale={prepared.fit}>
        <primitive object={prepared.root} />
      </group>
      {selected && mode === 'layout' && (
        <SelectionBox object={prepared.root} scale={prepared.fit} offset={prepared.offset} />
      )}

      {annotations.map((annotation, index) => (
        <Pin
          key={annotation.id}
          position={[annotation.point.x, annotation.point.y, annotation.point.z]}
          label={String(index + 1)}
          status={annotation.status}
          active={annotation.id === selectedAnnotationId}
          onClick={() => onSelectAnnotation(annotation.id)}
        />
      ))}

      {pendingPin && pendingPin.nodeId === node.id && (
        <Pin
          position={[pendingPin.point.x, pendingPin.point.y, pendingPin.point.z]}
          label="+"
          status="open"
          active
          pending
        />
      )}
    </group>
  );
}

const PIN_COLORS = {
  open: '#d99b42',
  applied: '#4ba26a',
  dismissed: '#6b6660',
} as const;

/**
 * A pinned note in the viewport.
 *
 * The badge is drei <Html>, so it is real DOM rather than canvas content -
 * which also means pins never appear in a captured or path-traced render.
 */
function Pin({
  position,
  label,
  status,
  active,
  pending = false,
  onClick,
}: {
  position: [number, number, number];
  label: string;
  status: 'open' | 'applied' | 'dismissed';
  active: boolean;
  pending?: boolean;
  onClick?: () => void;
}) {
  const color = PIN_COLORS[status];
  return (
    <group position={position} userData={{ helper: true }}>
      <mesh raycast={pending ? () => null : undefined} onClick={onClick && ((e) => { e.stopPropagation(); onClick(); })}>
        <sphereGeometry args={[active ? 0.045 : 0.032, 16, 16]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
      </mesh>
      <Html center distanceFactor={6} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <span
          style={{
            background: color,
            color: '#1a1917',
            borderRadius: 999,
            padding: '1px 6px',
            fontSize: 11,
            fontWeight: 700,
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            whiteSpace: 'nowrap',
            boxShadow: active ? '0 0 0 2px #e9e5dd' : 'none',
          }}
        >
          {label}
        </span>
      </Html>
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
