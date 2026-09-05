'use client';

import { Grid } from '@react-three/drei';

import type { EnvironmentSettings } from '@/lib/types';

const WALL_THICKNESS = 0.06;

/**
 * The stand itself: floor, up to three walls, and an optional layout grid.
 *
 * Walls matter more than they look - in a booth render most of the light on the
 * furniture is bounced off them, so their colour tints every material.
 */
export function Booth({ environment }: { environment: EnvironmentSettings }) {
  const { boothWidth: w, boothDepth: d, boothHeight: h, walls } = environment;

  return (
    <group userData={{ exportable: true }} name="booth">
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

      {environment.showGrid && (
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
          position={[0, 0.002, 0]}
          userData={{ helper: true }}
        />
      )}
    </group>
  );
}

function Wall({
  position,
  size,
  color,
}: {
  position: [number, number, number];
  size: [number, number, number];
  color: string;
}) {
  return (
    <mesh position={position} receiveShadow name="wall" userData={{ exportable: true }}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.92} metalness={0} />
    </mesh>
  );
}
