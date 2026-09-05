'use client';

import { ContactShadows, OrbitControls, TransformControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import { useStudio } from '@/lib/studio/store';
import type { SceneDoc } from '@/lib/types';

import { AssetNode } from './AssetNode';
import { Booth } from './Booth';
import { Lighting } from './Lighting';
import { PropNode } from './PropNode';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/**
 * The viewport.
 *
 * `exportRoot` is handed back to the parent so the export menu can serialise
 * exactly what is on screen. Helpers (grid, selection cages, gizmos) are tagged
 * with userData.helper and stripped at export time.
 */
export function StudioCanvas({
  doc,
  gizmoMode,
  onExportRootReady,
}: {
  doc: SceneDoc;
  gizmoMode: GizmoMode;
  onExportRootReady: (root: THREE.Group | null) => void;
}) {
  const { camera, environment, nodes } = doc;

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true, preserveDrawingBuffer: true, toneMapping: THREE.ACESFilmicToneMapping }}
      camera={{
        position: [camera.position.x, camera.position.y, camera.position.z],
        fov: camera.fov,
        near: 0.05,
        far: 400,
      }}
      onPointerMissed={() => useStudio.getState().select(null)}
    >
      <color attach="background" args={[environment.backgroundColorHex]} />
      <Suspense fallback={null}>
        <Lighting environment={environment} lightNodes={nodes.filter((n) => n.kind === 'light')} />
        <SceneContents doc={doc} gizmoMode={gizmoMode} onExportRootReady={onExportRootReady} />
      </Suspense>
      <CameraSync doc={doc} />
    </Canvas>
  );
}

function SceneContents({
  doc,
  gizmoMode,
  onExportRootReady,
}: {
  doc: SceneDoc;
  gizmoMode: GizmoMode;
  onExportRootReady: (root: THREE.Group | null) => void;
}) {
  const rootRef = useRef<THREE.Group>(null);
  const versions = useStudio((s) => s.versions);
  const selectedId = useStudio((s) => s.selectedId);
  const select = useStudio((s) => s.select);
  const patchNode = useStudio((s) => s.patchNode);
  const transforming = useStudio((s) => s.transforming);
  const setTransforming = useStudio((s) => s.setTransforming);

  const [selectedObject, setSelectedObject] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    onExportRootReady(rootRef.current);
    return () => onExportRootReady(null);
  }, [onExportRootReady]);

  // Find the group that carries the selected node id, so the gizmo attaches to
  // the same transform the scene document stores.
  useEffect(() => {
    if (!selectedId || !rootRef.current) {
      setSelectedObject(null);
      return;
    }
    let found: THREE.Object3D | null = null;
    rootRef.current.traverse((child) => {
      if (child.userData?.nodeId === selectedId) found = child;
    });
    setSelectedObject(found);
  }, [selectedId, doc.nodes]);

  const selectedNode = doc.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <>
      <group ref={rootRef} name="scene-root">
        <Booth environment={doc.environment} />

        {doc.nodes.map((node) => {
          if (node.kind === 'asset' && node.assetVersionId) {
            const loaded = versions[node.assetVersionId];
            if (!loaded?.meshUrl) return null;
            return (
              <AssetNode
                key={node.id}
                node={node}
                version={loaded.version}
                meshUrl={loaded.meshUrl}
                selected={node.id === selectedId}
                onSelect={() => select(node.id)}
              />
            );
          }
          if (node.kind === 'prop') {
            return (
              <PropNode
                key={node.id}
                node={node}
                selected={node.id === selectedId}
                onSelect={() => select(node.id)}
              />
            );
          }
          return null;
        })}
      </group>

      {/* Grounds everything with soft occlusion under the pieces. */}
      <ContactShadows
        position={[0, 0.001, 0]}
        scale={Math.max(doc.environment.boothWidth, doc.environment.boothDepth) * 1.4}
        opacity={0.5}
        blur={2.4}
        far={4}
        resolution={1024}
        color="#000000"
      />

      {selectedObject && selectedNode && (
        <TransformControls
          object={selectedObject}
          mode={gizmoMode}
          onMouseDown={() => setTransforming(true)}
          onMouseUp={() => {
            setTransforming(false);
            // Read the gizmo's result back into the document rather than
            // letting the three.js object and the document drift apart.
            const o = selectedObject;
            patchNode(selectedNode.id, {
              transform: {
                position: { x: o.position.x, y: o.position.y, z: o.position.z },
                rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
                scale: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
              },
            });
          }}
        />
      )}

      <OrbitControls
        makeDefault
        enabled={!transforming}
        target={[doc.camera.target.x, doc.camera.target.y, doc.camera.target.z]}
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI / 2 - 0.02}
        minDistance={0.8}
        maxDistance={40}
      />
    </>
  );
}

/** Applies field-of-view changes made in the inspector to the live camera. */
function CameraSync({ doc }: { doc: SceneDoc }) {
  const camera = useThree((state) => state.camera);
  const fov = doc.camera.fov;

  useEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera && camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }, [camera, fov]);

  return null;
}
