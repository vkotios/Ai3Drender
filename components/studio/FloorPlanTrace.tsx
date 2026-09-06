'use client';

import { Line, useTexture } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useState } from 'react';

import { MAX_FOOTPRINT_POINTS } from '@/lib/scene/footprint';
import { fetchBlobUrl } from '@/lib/studio/blobUrl';
import { useStudio } from '@/lib/studio/store';
import type { FloorPlanUnderlay as FloorPlanUnderlayData, FootprintPoint } from '@/lib/types';

import { MeshUrlBoundary } from './MeshUrlBoundary';

/** Big enough to trace against comfortably with no reference image loaded. */
const GROUND_EXTENT_M = 60;
/** Trace vertices sit slightly above the floor to avoid z-fighting with it. */
const TRACE_Y = 0.01;

/**
 * The floor-plan reference underlay plus the in-progress trace polygon
 * (issue #52 Phase A - see docs/proposals/cad-floor-plan-import.md and
 * lib/scene/footprint.ts).
 *
 * Reuses the freehand-stroke pointer pattern from issue #63 in its simplest
 * form: no drag/pointer-capture is needed here (a trace is a sequence of
 * plain clicks, not a continuous drawn line), so this just adds an
 * `onClick` and `onDoubleClick` to whatever the user is clicking against -
 * the uploaded underlay image when one is set, otherwise a large invisible
 * ground plane, so tracing works even with no reference photo at all.
 *
 * Only mounted (by StudioCanvas) while `mode === 'floorplan'` and never
 * while path-tracing: unlike the real floor/walls Booth.tsx builds from the
 * finished footprint, this is a viewport aid only, and the live path tracer
 * reads the three.js scene directly rather than through the export filter
 * that would otherwise strip it (see lib/studio/export.ts's `userData.helper`
 * convention, which only protects the *exported* file, not a path-traced
 * frame).
 */
export function FloorPlanTrace() {
  const mode = useStudio((s) => s.mode);
  const doc = useStudio((s) => s.doc);
  const trace = useStudio((s) => s.floorplanTrace);
  const addTracePoint = useStudio((s) => s.addTracePoint);
  const finishFloorplanTrace = useStudio((s) => s.finishFloorplanTrace);

  if (mode !== 'floorplan' || !doc) return null;
  const underlay = doc.environment.footprint?.underlay ?? null;

  const onPick = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (trace.length >= MAX_FOOTPRINT_POINTS) return;
    addTracePoint({ x: event.point.x, z: event.point.z });
  };

  const onFinish = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    finishFloorplanTrace();
  };

  return (
    <group userData={{ helper: true }} name="floorplan-trace">
      {underlay ? (
        <UnderlayImage underlay={underlay} onClick={onPick} onDoubleClick={onFinish} />
      ) : (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -0.002, 0]}
          onClick={onPick}
          onDoubleClick={onFinish}
        >
          <planeGeometry args={[GROUND_EXTENT_M, GROUND_EXTENT_M]} />
          <meshBasicMaterial visible={false} />
        </mesh>
      )}

      <TracePreview points={trace} />
    </group>
  );
}

/** Resolves the underlay's blob key to a fetchable URL, then keeps it fresh - same mechanism AssetNode uses for mesh URLs. */
function UnderlayImage({
  underlay,
  onClick,
  onDoubleClick,
}: {
  underlay: FloorPlanUnderlayData;
  onClick: (e: ThreeEvent<PointerEvent>) => void;
  onDoubleClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const [resolved, setResolved] = useState<{ url: string; expiresAt: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    fetchBlobUrl(underlay.imagePath)
      .then((next) => {
        if (!cancelled) setResolved(next);
      })
      .catch(() => {
        // Left unresolved: the ground plane isn't rendered here regardless,
        // so tracing without the image just has nothing to show against.
      });
    return () => {
      cancelled = true;
    };
  }, [underlay.imagePath]);

  if (!resolved) return null;

  return (
    <MeshUrlBoundary
      meshKey={underlay.imagePath}
      initialUrl={resolved.url}
      initialExpiresAt={resolved.expiresAt}
    >
      {(url) => (
        <group position={[underlay.centerX, -0.001, underlay.centerZ]} rotation={[0, underlay.rotationY, 0]}>
          <UnderlayPlane url={url} widthM={underlay.widthM} heightM={underlay.heightM} onClick={onClick} onDoubleClick={onDoubleClick} />
        </group>
      )}
    </MeshUrlBoundary>
  );
}

function UnderlayPlane({
  url,
  widthM,
  heightM,
  onClick,
  onDoubleClick,
}: {
  url: string;
  widthM: number;
  heightM: number;
  onClick: (e: ThreeEvent<PointerEvent>) => void;
  onDoubleClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const texture = useTexture(url);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} onClick={onClick} onDoubleClick={onDoubleClick} name="floorplan-underlay">
      <planeGeometry args={[widthM, heightM]} />
      <meshBasicMaterial map={texture} toneMapped={false} transparent opacity={0.92} />
    </mesh>
  );
}

/** The polygon traced so far: a closing preview once there are enough points, plus a small marker at each vertex. */
function TracePreview({ points }: { points: FootprintPoint[] }) {
  if (points.length === 0) return null;
  const vertices: [number, number, number][] = points.map((p) => [p.x, TRACE_Y, p.z]);
  const path = points.length >= 3 ? [...vertices, vertices[0]] : vertices;

  return (
    <>
      {vertices.length > 1 && (
        <Line
          points={path}
          color="#e9c46a"
          lineWidth={2}
          transparent
          opacity={0.9}
          depthTest={false}
          raycast={() => null}
        />
      )}
      {points.map((p, i) => (
        <mesh key={i} position={[p.x, TRACE_Y, p.z]} raycast={() => null}>
          <sphereGeometry args={[0.06, 12, 12]} />
          <meshBasicMaterial color="#e9c46a" depthTest={false} />
        </mesh>
      ))}
    </>
  );
}
