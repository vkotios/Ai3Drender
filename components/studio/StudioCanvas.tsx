'use client';

import { ContactShadows, OrbitControls, TransformControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import { viewportMeshPath } from '@/lib/db/store';
import { useStudio } from '@/lib/studio/store';
import type { SceneDoc } from '@/lib/types';

import { AssetNode } from './AssetNode';
import { Booth } from './Booth';
import { Lighting } from './Lighting';
import { PathTracer } from './PathTracer';
import { PropNode } from './PropNode';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** 'preview' is the real-time viewport; 'pathtrace' converges a final frame. */
export type RenderMode = 'preview' | 'pathtrace';

export interface RenderSettings {
  bounces: number;
  maxSamples: number;
  resolutionScale: number;
}

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
  renderMode,
  renderSettings,
  onSamples,
  onExportRootReady,
  onCanvasReady,
}: {
  doc: SceneDoc;
  gizmoMode: GizmoMode;
  renderMode: RenderMode;
  renderSettings: RenderSettings;
  onSamples: (samples: number, converged: boolean) => void;
  onExportRootReady: (root: THREE.Group | null) => void;
  onCanvasReady: (canvas: HTMLCanvasElement | null) => void;
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
        <SceneContents
          doc={doc}
          gizmoMode={gizmoMode}
          renderMode={renderMode}
          renderSettings={renderSettings}
          onSamples={onSamples}
          onExportRootReady={onExportRootReady}
        />
      </Suspense>
      <CameraSync doc={doc} />
      <CanvasHandle onReady={onCanvasReady} />
    </Canvas>
  );
}

function SceneContents({
  doc,
  gizmoMode,
  renderMode,
  renderSettings,
  onSamples,
  onExportRootReady,
}: {
  doc: SceneDoc;
  gizmoMode: GizmoMode;
  renderMode: RenderMode;
  renderSettings: RenderSettings;
  onSamples: (samples: number, converged: boolean) => void;
  onExportRootReady: (root: THREE.Group | null) => void;
}) {
  // While a frame is converging, everything that exists to help the operator -
  // grid, selection cages, pins, gizmo, the faked contact shadows - has to go,
  // or it ends up baked into the render.
  const presenting = renderMode === 'pathtrace';
  const rootRef = useRef<THREE.Group>(null);
  const versions = useStudio((s) => s.versions);
  const selectedId = useStudio((s) => s.selectedId);
  const select = useStudio((s) => s.select);
  const patchNode = useStudio((s) => s.patchNode);
  const transforming = useStudio((s) => s.transforming);
  const setTransforming = useStudio((s) => s.setTransforming);
  const mode = useStudio((s) => s.mode);
  const annotations = useStudio((s) => s.annotations);
  const pendingPin = useStudio((s) => s.pendingPin);
  const setPendingPin = useStudio((s) => s.setPendingPin);
  const selectedAnnotationId = useStudio((s) => s.selectedAnnotationId);
  const selectAnnotation = useStudio((s) => s.selectAnnotation);

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
        <Booth environment={doc.environment} showGrid={!presenting} />

        {doc.nodes.map((node) => {
          if (node.kind === 'asset' && node.assetVersionId) {
            const loaded = versions[node.assetVersionId];
            // Whichever mesh key `loaded.meshUrl` was actually resolved from -
            // the decimated preview when reconstruct produced one, else the
            // full-detail mesh - so MeshUrlBoundary refreshes the same object
            // it originally loaded rather than silently swapping URLs later.
            const meshKey = loaded && viewportMeshPath(loaded.version);
            if (!loaded?.meshUrl || !meshKey) return null;
            return (
              <AssetNode
                key={node.id}
                node={node}
                version={loaded.version}
                meshPath={meshKey}
                meshUrl={loaded.meshUrl}
                meshUrlExpiresAt={loaded.meshUrlExpiresAt}
                selected={!presenting && node.id === selectedId}
                mode={mode}
                annotations={
                  presenting
                    ? []
                    : annotations.filter(
                        (a) => a.assetId === loaded.version.assetId && a.status !== 'dismissed',
                      )
                }
                pendingPin={presenting ? null : pendingPin}
                selectedAnnotationId={selectedAnnotationId}
                onSelect={() => select(node.id)}
                onPin={(pin) =>
                  setPendingPin({
                    ...pin,
                    nodeId: node.id,
                    assetId: loaded.version.assetId,
                    assetVersionId: loaded.version.id,
                  })
                }
                onSelectAnnotation={selectAnnotation}
              />
            );
          }
          if (node.kind === 'prop') {
            return (
              <PropNode
                key={node.id}
                node={node}
                selected={!presenting && node.id === selectedId}
                onSelect={() => select(node.id)}
              />
            );
          }
          return null;
        })}
      </group>

      {/* Approximates occlusion under the pieces. The path tracer computes the
          real thing, so this is dropped while rendering. */}
      {!presenting && (
      <ContactShadows
        position={[0, 0.001, 0]}
        scale={Math.max(doc.environment.boothWidth, doc.environment.boothDepth) * 1.4}
        opacity={0.5}
        blur={2.4}
        far={4}
        resolution={1024}
        color="#000000"
      />
      )}

      {presenting && (
        <PathTracer
          bounces={renderSettings.bounces}
          maxSamples={renderSettings.maxSamples}
          resolutionScale={renderSettings.resolutionScale}
          fallbackTopColor={doc.environment.backgroundColorHex}
          fallbackBottomColor={doc.environment.floorColorHex}
          onSamples={onSamples}
        />
      )}

      {mode === 'layout' && !presenting && selectedObject && selectedNode && (
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

/** Hands the underlying canvas out so renders can be read back as PNG. */
function CanvasHandle({ onReady }: { onReady: (canvas: HTMLCanvasElement | null) => void }) {
  const canvas = useThree((state) => state.gl.domElement);
  useEffect(() => {
    onReady(canvas);
    return () => onReady(null);
  }, [canvas, onReady]);
  return null;
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
