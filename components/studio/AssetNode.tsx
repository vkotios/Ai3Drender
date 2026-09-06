'use client';

import { Html, Line, useGLTF } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

import { baseName } from '@/lib/scene/anchor';
import {
  MIN_STROKE_POINTS,
  appendStrokeSample,
  primaryStrokePartName,
  strokeCentroid,
} from '@/lib/scene/stroke';
import { applyMaterialOverrides } from '@/lib/studio/applyMaterialOverrides';
import type { Annotation, AssetVersion, SceneNode, StrokePoint } from '@/lib/types';
import { useStudio, type PendingPin, type StudioMode } from '@/lib/studio/store';

import { MeshUrlBoundary } from './MeshUrlBoundary';

/**
 * Minimum spacing between kept freehand samples, in metres.
 *
 * Throttles a pointer-move stream that can otherwise fire far faster than
 * anyone actually needs points recorded - without this a slow drag across a
 * piece a couple of metres across would accumulate thousands of nearly
 * identical samples.
 */
const MIN_STROKE_SAMPLE_DISTANCE_M = 0.01;

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
  const selectionMode = useStudio((s) => s.selectionMode);

  // Freehand capture: samples accumulate in a ref (not state) so a fast
  // pointer-move stream never has to wait on React, and are mirrored into
  // `liveStroke` state only when a sample actually survives the min-distance
  // throttle, so the in-progress line redraws without re-rendering on every
  // dropped sample.
  const strokeRef = useRef<StrokePoint[]>([]);
  const [liveStroke, setLiveStroke] = useState<StrokePoint[]>([]);
  // Set only while a stroke is in progress; also doubles as the finish
  // handler so window-level pointerup/cancel listeners (registered below)
  // can call the exact same finalize path a same-object pointerup would.
  const finalizeStrokeRef = useRef<(() => void) | null>(null);

  // A stroke is finalized by a *window* listener rather than this mesh's own
  // onPointerUp: react-three-fiber only calls an object's pointer handlers
  // while the ray still intersects it, so releasing after the cursor has
  // slid off the model's silhouette mid-drag would otherwise never fire
  // onPointerUp here at all, leaving `drawing` stuck true and orbit
  // permanently disabled. A native window listener fires regardless of
  // where the ray lands.
  useEffect(() => {
    return () => {
      // Unmounting mid-stroke (piece removed, version swapped) must not
      // leave OrbitControls disabled for the rest of the session.
      finalizeStrokeRef.current?.();
    };
  }, []);

  /** A stroke sample: this group's local space, plus whatever part it hit. */
  const sampleFromEvent = (event: ThreeEvent<PointerEvent>): StrokePoint | null => {
    const group = groupRef.current;
    if (!group) return null;
    const local = group.worldToLocal(event.point.clone());
    return { point: { x: local.x, y: local.y, z: local.z }, partName: event.object.name || null };
  };

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (mode !== 'comment' || selectionMode !== 'freehand') return;
    event.stopPropagation();

    const first = sampleFromEvent(event);
    strokeRef.current = first ? [first] : [];
    setLiveStroke(strokeRef.current);
    useStudio.getState().setDrawing(true);

    // Best-effort: keeps this pointer's events flowing to the canvas even if
    // released outside it. Never throws in practice, but pointer capture is
    // not implemented everywhere (older WebViews), so this must not be fatal.
    try {
      (event.nativeEvent.target as Element | null)?.setPointerCapture?.(event.nativeEvent.pointerId);
    } catch {
      // Drawing still works without capture - it just won't survive a
      // release past the canvas edge.
    }

    const finalize = () => {
      window.removeEventListener('pointerup', finalize);
      window.removeEventListener('pointercancel', finalize);
      finalizeStrokeRef.current = null;
      useStudio.getState().setDrawing(false);

      const samples = strokeRef.current;
      strokeRef.current = [];
      setLiveStroke([]);

      // The mode may have changed while the stroke was in progress (the
      // reviewer switched tools or left comment mode mid-drag) - honour
      // that rather than surfacing a note for a gesture that no longer
      // matches what's on screen.
      const state = useStudio.getState();
      if (state.mode !== 'comment' || state.selectionMode !== 'freehand') return;
      if (samples.length < MIN_STROKE_POINTS) return; // a tap, not a drawn stroke.

      onPin({
        point: strokeCentroid(samples),
        normal: { x: 0, y: 1, z: 0 },
        partName: primaryStrokePartName(samples),
        selectionKind: 'freehand',
        instanceCount: 1,
        strokePoints: samples,
      });
    };
    finalizeStrokeRef.current = finalize;
    window.addEventListener('pointerup', finalize);
    window.addEventListener('pointercancel', finalize);
  };

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!finalizeStrokeRef.current) return; // no stroke in progress on this piece.
    event.stopPropagation();
    const sample = sampleFromEvent(event);
    if (!sample) return;
    const next = appendStrokeSample(strokeRef.current, sample, MIN_STROKE_SAMPLE_DISTANCE_M);
    if (next !== strokeRef.current) {
      strokeRef.current = next;
      setLiveStroke(next);
    }
  };

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
  // resolveMaterialOverrideKey (inside applyMaterialOverrides) resolves each
  // mesh material back to the spec id that currently carries its name, and
  // only falls back to the raw mesh name when nothing in the spec matches it
  // (a vendor mesh whose material names we do not control).
  useMemo(() => {
    applyMaterialOverrides(prepared.root, node.materialOverrides, version.spec.materials);
  }, [prepared.root, node.materialOverrides, version.spec.materials]);

  // When the viewport is showing the decimated preview mesh, tag the wrapper
  // that carries its fit/offset with enough to find and reload the
  // full-detail one at export time (lib/studio/export.ts) - the glTF/OBJ
  // export must never ship the preview mesh (issue #47). Null whenever there
  // is nothing to swap: no preview in play, or reconstruction hasn't stored
  // a full mesh at all (shouldn't happen once a version is ready, but this
  // component has no reason to assume it).
  const exportUserData = useMemo(
    () => ({
      fullMeshPath: version.previewMeshPath && version.meshPath ? version.meshPath : null,
      materialOverrides: node.materialOverrides,
      specMaterials: version.spec.materials,
    }),
    [version.previewMeshPath, version.meshPath, node.materialOverrides, version.spec.materials],
  );

  /**
   * A click either selects the piece or pins a note - to the exact spot, or
   * to the whole named part under the cursor, depending on the current
   * selection mode (Shift flips it for this one click).
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
    // A freehand selection is captured by the pointer down/move/up handlers
    // above instead - a bare click there is just a stroke too short to keep
    // (see MIN_STROKE_POINTS), not a point pin.
    if (selectionMode === 'freehand') return;

    const group = groupRef.current;
    if (!group) return;

    const hitPartName = event.object.name || null;
    const wantsWholePart = event.shiftKey ? selectionMode === 'point' : selectionMode === 'part';

    // Our massing meshes name each part after its component; vendor meshes
    // may not, in which case there is nothing to group by and this falls
    // back to pinning the exact point regardless of the selection mode.
    if (wantsWholePart && hitPartName) {
      const target = baseName(hitPartName).toLowerCase();
      const matches: THREE.Object3D[] = [];
      prepared.root.traverse((child) => {
        if (child instanceof THREE.Mesh && baseName(child.name || '').toLowerCase() === target) {
          matches.push(child);
        }
      });

      if (matches.length > 0) {
        const worldBox = new THREE.Box3();
        for (const match of matches) worldBox.union(new THREE.Box3().setFromObject(match));

        // An AABB's corners, not just its min/max, have to go through
        // worldToLocal individually - the group can be rotated, and
        // transforming only two opposite corners would not reproduce the
        // rotated box's true local-space extent.
        const { min, max } = worldBox;
        const localCorners = [
          [min.x, min.y, min.z], [min.x, min.y, max.z], [min.x, max.y, min.z], [min.x, max.y, max.z],
          [max.x, min.y, min.z], [max.x, min.y, max.z], [max.x, max.y, min.z], [max.x, max.y, max.z],
        ].map(([x, y, z]) => group.worldToLocal(new THREE.Vector3(x, y, z)));
        const center = new THREE.Box3().setFromPoints(localCorners).getCenter(new THREE.Vector3());

        onPin({
          point: { x: center.x, y: center.y, z: center.z },
          normal: { x: 0, y: 1, z: 0 },
          partName: baseName(hitPartName),
          selectionKind: 'part',
          instanceCount: matches.length,
        });
        return;
      }
    }

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
      partName: hitPartName,
      selectionKind: 'point',
      instanceCount: 1,
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
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      userData={{ nodeId: node.id, exportable: true }}
    >
      <group position={prepared.offset} scale={prepared.fit} userData={exportUserData}>
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
      {annotations.map((annotation) =>
        annotation.selectionKind === 'freehand' &&
        annotation.strokePoints &&
        annotation.strokePoints.length > 1 ? (
          <FreehandStroke
            key={`stroke-${annotation.id}`}
            points={annotation.strokePoints}
            status={annotation.status}
            active={annotation.id === selectedAnnotationId}
          />
        ) : null,
      )}

      {/* The stroke still being drawn, redrawn live as samples accumulate. */}
      {liveStroke.length > 1 && <FreehandStroke points={liveStroke} status="open" active pending />}

      {pendingPin && pendingPin.nodeId === node.id && (
        <>
          <Pin
            position={[pendingPin.point.x, pendingPin.point.y, pendingPin.point.z]}
            label="+"
            status="open"
            active
            pending
          />
          {pendingPin.selectionKind === 'freehand' &&
            pendingPin.strokePoints &&
            pendingPin.strokePoints.length > 1 && (
              <FreehandStroke points={pendingPin.strokePoints} status="open" active pending />
            )}
        </>
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

/**
 * A freehand annotation's stroke, drawn as a line following its sampled
 * points across the mesh surface - the same anchor space the Pin markers
 * above use, so it renders correctly under this same group's transform
 * regardless of camera angle.
 *
 * A fat (screen-space) line rather than plain `lineBasicMaterial`, since
 * WebGL's native line width is capped at 1px on most platforms and a
 * one-pixel stroke would be unreadable at any real distance from the piece.
 * Excluded from raycasting and export exactly like the Pin markers and
 * SelectionBox - a helper, never part of the exported mesh.
 */
function FreehandStroke({
  points,
  status,
  active,
  pending = false,
}: {
  points: { point: { x: number; y: number; z: number } }[];
  status: 'open' | 'applied' | 'dismissed';
  active: boolean;
  pending?: boolean;
}) {
  const vertices = useMemo<[number, number, number][]>(
    () => points.map((p) => [p.point.x, p.point.y, p.point.z]),
    [points],
  );
  if (vertices.length < 2) return null;

  return (
    <Line
      points={vertices}
      color={pending ? '#e9c46a' : PIN_COLORS[status]}
      lineWidth={active ? 3 : 2}
      transparent
      opacity={pending ? 0.85 : 0.95}
      depthTest={false}
      userData={{ helper: true }}
      raycast={() => null}
    />
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
