'use client';

import { Environment } from '@react-three/drei';

import type { EnvironmentSettings, SceneNode } from '@/lib/types';

import { EnvironmentBoundary } from './EnvironmentFallback';

/**
 * Image-based lighting plus a shadow-casting key.
 *
 * The HDRI does almost all the work on reflective materials; the directional
 * light exists mainly to ground the furniture with a real contact shadow, which
 * is the single strongest cue that a render is not floating.
 */
export function Lighting({
  environment,
  lightNodes,
}: {
  environment: EnvironmentSettings;
  lightNodes: SceneNode[];
}) {
  const reach = Math.max(environment.boothWidth, environment.boothDepth);

  return (
    <>
      <EnvironmentBoundary
        fallback={
          // Approximates the missing environment map so materials still read.
          <>
            <hemisphereLight
              intensity={environment.hdriIntensity * 0.6}
              color="#ffffff"
              groundColor={environment.floorColorHex}
            />
            <directionalLight
              position={[-reach, environment.boothHeight, -reach * 0.6]}
              intensity={0.35}
            />
          </>
        }
      >
        <Environment
          preset={environment.hdriPreset as never}
          environmentIntensity={environment.hdriIntensity}
          background={false}
        />
      </EnvironmentBoundary>
      <ambientLight intensity={environment.ambientIntensity} />

      <directionalLight
        position={[reach * 0.55, environment.boothHeight * 1.6, reach * 0.45]}
        intensity={1.15}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
      >
        {/* Tighten the shadow frustum to the booth so the map is not wasted. */}
        <orthographicCamera
          attach="shadow-camera"
          args={[-reach, reach, reach, -reach, 0.1, reach * 4]}
        />
      </directionalLight>

      {lightNodes
        .filter((node) => node.visible && node.light)
        .map((node) => (
          <pointLight
            key={node.id}
            position={[
              node.transform.position.x,
              node.transform.position.y,
              node.transform.position.z,
            ]}
            color={node.light!.colorHex}
            intensity={node.light!.intensity}
            distance={node.light!.distance}
            decay={2}
          />
        ))}
    </>
  );
}
