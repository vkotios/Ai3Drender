'use client';

import { ContactShadows, OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense, useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';

import { Button } from '@/components/ui';
import { useFullscreen } from '@/lib/studio/useFullscreen';
import type { LoadedVersion } from '@/lib/studio/store';
import type { CameraSettings, SceneDoc } from '@/lib/types';

import { AssetNode } from './AssetNode';
import { Booth } from './Booth';
import { FullscreenButton } from './FullscreenButton';
import { Lighting } from './Lighting';
import { PropNode } from './PropNode';

export interface ComparePane {
  label: string;
  sublabel?: string;
  doc: SceneDoc;
  /** Only the versions this pane's own nodes need - never the studio's whole map. */
  versions: Record<string, LoadedVersion>;
}

/**
 * Two viewports, camera-locked together.
 *
 * The A/B toggle elsewhere in the studio swaps one mesh in for another in the
 * same spot; this renders both at once, side by side, and keeps their cameras
 * identical - orbiting or zooming either pane moves both; there is nothing to
 * "sync" by hand. Read-only: no selection, gizmos, annotations or path
 * tracing, since this view exists to look, not to edit.
 */
export function CompareViewport({ left, right }: { left: ComparePane; right: ComparePane }) {
  const controlsA = useRef<OrbitControlsImpl | null>(null);
  const controlsB = useRef<OrbitControlsImpl | null>(null);
  // Guards against the mirrored update's own 'change' event bouncing back and
  // re-mirroring in the other direction.
  const syncing = useRef(false);

  // Both panes start framed the same way - after that, only the left pane's
  // camera matters as a starting point, since orbiting is locked from the
  // first frame.
  const initialCamera = left.doc.camera;

  const mirror = useCallback(
    (from: RefObject<OrbitControlsImpl | null>, to: RefObject<OrbitControlsImpl | null>) => {
      if (syncing.current) return;
      const source = from.current;
      const target = to.current;
      if (!source || !target) return;
      syncing.current = true;
      target.object.position.copy(source.object.position);
      target.object.quaternion.copy(source.object.quaternion);
      target.target.copy(source.target);
      target.update();
      syncing.current = false;
    },
    [],
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-px bg-shell-800">
      <ComparePaneView
        pane={left}
        initialCamera={initialCamera}
        controlsRef={controlsA}
        onChange={() => mirror(controlsA, controlsB)}
      />
      <ComparePaneView
        pane={right}
        initialCamera={initialCamera}
        controlsRef={controlsB}
        onChange={() => mirror(controlsB, controlsA)}
      />
    </div>
  );
}

function ComparePaneView({
  pane,
  initialCamera,
  controlsRef,
  onChange,
}: {
  pane: ComparePane;
  initialCamera: CameraSettings;
  controlsRef: RefObject<OrbitControlsImpl | null>;
  onChange: () => void;
}) {
  const { environment, nodes } = pane.doc;

  return (
    <div className="relative flex min-h-0 flex-col bg-shell-900">
      <div className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-shell-950/85 px-2 py-1 text-[11px] font-medium text-shell-100">
        {pane.label}
        {pane.sublabel && <span className="ml-1.5 font-normal text-shell-400">{pane.sublabel}</span>}
      </div>
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
        camera={{
          position: [initialCamera.position.x, initialCamera.position.y, initialCamera.position.z],
          fov: initialCamera.fov,
          near: 0.05,
          far: 400,
        }}
      >
        <color attach="background" args={[environment.backgroundColorHex]} />
        <Suspense fallback={null}>
          <Lighting environment={environment} lightNodes={nodes.filter((n) => n.kind === 'light')} />
          <Booth environment={environment} showGrid />

          {nodes.map((node) => {
            if (node.kind === 'asset' && node.assetVersionId) {
              const loaded = pane.versions[node.assetVersionId];
              if (!loaded?.meshUrl || !loaded.version.meshPath) return null;
              return (
                <AssetNode
                  key={node.id}
                  node={node}
                  version={loaded.version}
                  meshPath={loaded.version.meshPath}
                  meshUrl={loaded.meshUrl}
                  meshUrlExpiresAt={loaded.meshUrlExpiresAt}
                  selected={false}
                  mode="layout"
                  annotations={[]}
                  pendingPin={null}
                  selectedAnnotationId={null}
                  onSelect={() => {}}
                  onPin={() => {}}
                  onSelectAnnotation={() => {}}
                />
              );
            }
            if (node.kind === 'prop') {
              return <PropNode key={node.id} node={node} selected={false} onSelect={() => {}} />;
            }
            return null;
          })}

          <ContactShadows
            position={[0, 0.001, 0]}
            scale={Math.max(environment.boothWidth, environment.boothDepth) * 1.4}
            opacity={0.5}
            blur={2.4}
            far={4}
            resolution={512}
            color="#000000"
          />
        </Suspense>

        <InitialTarget controlsRef={controlsRef} target={initialCamera.target} />
        <OrbitControls
          ref={controlsRef}
          makeDefault
          onChange={onChange}
          maxPolarAngle={Math.PI / 2 - 0.02}
          minDistance={0.8}
          maxDistance={40}
        />
      </Canvas>
    </div>
  );
}

/**
 * The side-by-side view as a full-viewport overlay - a two-pane 3D comparison
 * needs real space, which a docked sidebar panel doesn't have. Shared between
 * the asset-version compare (Inspector) and the scene-version compare
 * (VersionHistory), which differ only in how they build the two panes.
 */
export function SplitCompareOverlay({
  title,
  left,
  right,
  onClose,
}: {
  title: string;
  left: ComparePane;
  right: ComparePane;
  onClose: () => void;
}) {
  const viewportFullscreen = useFullscreen<HTMLDivElement>();
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 p-4">
      <div
        ref={viewportFullscreen.ref}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-shell-700 bg-shell-950 shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-shell-800 px-3.5 py-2.5">
          <div>
            <h2 className="text-sm font-semibold text-shell-100">{title}</h2>
            <p className="text-[11px] text-shell-400">Drag either pane to orbit both at once.</p>
          </div>
          <div className="flex gap-1.5">
            <FullscreenButton
              isFullscreen={viewportFullscreen.isFullscreen}
              onToggle={viewportFullscreen.toggle}
              supported={viewportFullscreen.supported}
            />
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <CompareViewport left={left} right={right} />
        </div>
      </div>
    </div>
  );
}

/**
 * Sets the orbit target once, imperatively, instead of via the declarative
 * `target` prop - that prop is re-applied on every prop-object identity
 * change, which would stomp the live sync the moment either pane re-renders.
 */
function InitialTarget({
  controlsRef,
  target,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
  target: CameraSettings['target'];
}) {
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.target.set(target.x, target.y, target.z);
    controls.update();
    // Deliberately once, on mount - see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
