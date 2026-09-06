'use client';

import { Grid } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';

import { footprintBounds, isValidFootprintBoundary, triangulatePolygon, wallSegmentPlacement } from '@/lib/scene/footprint';
import type { EnvironmentSettings } from '@/lib/types';

const WALL_THICKNESS = 0.06;

/**
 * The stand itself: floor, up to three walls, and an optional layout grid.
 *
 * Walls matter more than they look - in a booth render most of the light on the
 * furniture is bounced off them, so their colour tints every material.
 *
 * Renders a traced footprint polygon (issue #52 Phase A) in place of the
 * fixed rectangle whenever `environment.footprint` has a usable boundary -
 * see `lib/scene/footprint.ts`'s `isValidFootprintBoundary`. Falls back to
 * the rectangle for every scene saved before that shipped, or if the traced
 * data is ever malformed.
 */
export function Booth({
  environment,
  showGrid = true,
}: {
  environment: EnvironmentSettings;
  /** Forced off while path tracing - the grid is an operator aid, not set dressing. */
  showGrid?: boolean;
}) {
  const footprint = environment.footprint;
  const hasFootprint = !!footprint && isValidFootprintBoundary(footprint.boundary);

  return (
    <group userData={{ exportable: true }} name="booth">
      {hasFootprint ? (
        <FootprintFloorAndWalls environment={environment} />
      ) : (
        <RectangleFloorAndWalls environment={environment} />
      )}

      {environment.showGrid && showGrid && (
        <GridHelper environment={environment} />
      )}
    </group>
  );
}

function RectangleFloorAndWalls({ environment }: { environment: EnvironmentSettings }) {
  const { boothWidth: w, boothDepth: d, boothHeight: h, walls } = environment;

  return (
    <>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        name="floor"
        userData={{ exportable: true }}
      >
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial
          color={environment.floorColorHex}
          roughness={0.55}
          metalness={0}
          envMapIntensity={0.7}
        />
      </mesh>

      {walls.back && (
        <Wall
          position={[0, h / 2, -d / 2]}
          size={[w, h, WALL_THICKNESS]}
          color={environment.wallColorHex}
        />
      )}
      {walls.left && (
        <Wall
          position={[-w / 2, h / 2, 0]}
          size={[WALL_THICKNESS, h, d]}
          color={environment.wallColorHex}
        />
      )}
      {walls.right && (
        <Wall
          position={[w / 2, h / 2, 0]}
          size={[WALL_THICKNESS, h, d]}
          color={environment.wallColorHex}
        />
      )}
    </>
  );
}

/**
 * Floor and walls built from a traced polygon rather than the fixed
 * rectangle. Wall height still comes from `environment.boothHeight` - a
 * traced footprint only ever replaces the *plan*, not the height control in
 * the inspector.
 */
function FootprintFloorAndWalls({ environment }: { environment: EnvironmentSettings }) {
  const footprint = environment.footprint!;
  const h = environment.boothHeight;

  const floorGeometry = useMemo(() => {
    const boundary = footprint.boundary;
    const triangles = triangulatePolygon(boundary);
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(boundary.length * 3);
    const normals = new Float32Array(boundary.length * 3);
    boundary.forEach((p, i) => {
      positions.set([p.x, 0, p.z], i * 3);
      normals.set([0, 1, 0], i * 3);
    });
    const indices = new Uint32Array(triangles.length * 3);
    triangles.forEach(([a, b, c], i) => indices.set([a, b, c], i * 3));
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return geometry;
    // footprint.boundary is replaced wholesale on every edit (never mutated
    // in place), so identity is a safe memo key.
  }, [footprint.boundary]);

  return (
    <>
      <mesh geometry={floorGeometry} receiveShadow name="floor" userData={{ exportable: true }}>
        <meshStandardMaterial
          color={environment.floorColorHex}
          roughness={0.55}
          metalness={0}
          envMapIntensity={0.7}
          // A hand-traced polygon can come in either winding order depending
          // on which way the user clicked around it - double-sided
          // sidesteps that rather than policing it (matches the server
          // export path, see lib/render/build-scene.ts).
          side={THREE.DoubleSide}
        />
      </mesh>

      {footprint.walls.map((wall, i) => {
        if (wall.open) return null;
        const placement = wallSegmentPlacement(wall);
        if (placement.length < 1e-6) return null; // a degenerate (zero-length) traced segment.
        return (
          <Wall
            key={i}
            position={[placement.centerX, h / 2, placement.centerZ]}
            rotationY={placement.rotationY}
            size={[placement.length, h, WALL_THICKNESS]}
            color={environment.wallColorHex}
          />
        );
      })}
    </>
  );
}

function GridHelper({ environment }: { environment: EnvironmentSettings }) {
  const footprint = environment.footprint;
  const hasFootprint = !!footprint && isValidFootprintBoundary(footprint.boundary);
  const bounds = hasFootprint ? footprintBounds(footprint!.boundary) : null;
  const w = bounds?.width ?? environment.boothWidth;
  const d = bounds?.depth ?? environment.boothDepth;

  return (
    <Grid
      args={[w, d]}
      cellSize={0.5}
      cellThickness={0.5}
      cellColor="#6f6a60"
      sectionSize={1}
      sectionThickness={1}
      sectionColor="#8d867a"
      fadeDistance={28}
      followCamera={false}
      infiniteGrid={false}
      position={[bounds?.centerX ?? 0, 0.002, bounds?.centerZ ?? 0]}
      userData={{ helper: true }}
    />
  );
}

function Wall({
  position,
  size,
  color,
  rotationY = 0,
}: {
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  /** Radians about Y - lets a footprint wall follow an angled traced segment. Defaults to 0 for the axis-aligned rectangle walls. */
  rotationY?: number;
}) {
  return (
    <mesh position={position} rotation={[0, rotationY, 0]} receiveShadow name="wall" userData={{ exportable: true }}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.92} metalness={0} />
    </mesh>
  );
}
