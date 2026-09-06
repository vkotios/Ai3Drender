'use client';

import { useGLTF } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * Renders one mesh in a small canvas just long enough to capture a PNG
 * thumbnail, hands the result back, then keeps rendering (cheaply - it is
 * still on screen as the thumbnail itself) but only ever uploads once.
 *
 * Framed off the mesh's own bounding box rather than the spec's real-world
 * dimensions - it only has to look right at thumbnail size, not be
 * dimensionally comparable to anything else the way the studio viewport is.
 */
export function ThumbnailCapture({
  assetId,
  versionId,
  meshUrl,
  onCaptured,
}: {
  assetId: string;
  versionId: string;
  meshUrl: string;
  onCaptured: (localUrl: string) => void;
}) {
  return (
    <Canvas
      dpr={1}
      gl={{ antialias: true, preserveDrawingBuffer: true, toneMapping: THREE.ACESFilmicToneMapping }}
      camera={{ fov: 32, near: 0.05, far: 100 }}
    >
      <color attach="background" args={['#211f1b']} />
      <ambientLight intensity={1} />
      <directionalLight position={[3, 5, 4]} intensity={1.5} />
      <directionalLight position={[-3, 2, -2]} intensity={0.4} />
      <Suspense fallback={null}>
        <FramedMesh meshUrl={meshUrl} />
        <Capturer assetId={assetId} versionId={versionId} onCaptured={onCaptured} />
      </Suspense>
    </Canvas>
  );
}

function FramedMesh({ meshUrl }: { meshUrl: string }) {
  const { scene } = useGLTF(meshUrl);
  const { camera } = useThree();

  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.01);
    const distance = radius * 1.9;

    camera.position.set(
      center.x + distance * 0.55,
      center.y + distance * 0.45,
      center.z + distance * 0.85,
    );
    camera.lookAt(center);
    if (camera instanceof THREE.PerspectiveCamera) camera.updateProjectionMatrix();
  }, [scene, camera]);

  return <primitive object={scene} />;
}

/** Waits for a few settled frames, grabs the canvas, then reports back once. */
function Capturer({
  assetId,
  versionId,
  onCaptured,
}: {
  assetId: string;
  versionId: string;
  onCaptured: (localUrl: string) => void;
}) {
  const frames = useRef(0);
  const [done, setDone] = useState(false);
  const { gl } = useThree();

  useFrame(() => {
    if (done) return;
    frames.current += 1;
    // A few frames gives textures and the first paint time to settle before
    // the canvas is read back.
    if (frames.current < 6) return;
    setDone(true);

    gl.domElement.toBlob((blob) => {
      if (!blob) return;
      onCaptured(URL.createObjectURL(blob));

      const form = new FormData();
      form.append('file', blob, 'preview.png');
      fetch(`/api/assets/${assetId}/versions/${versionId}/preview`, {
        method: 'POST',
        body: form,
      }).catch(() => {
        // Best-effort cache; the just-captured image is already on screen.
      });
    }, 'image/png');
  });

  return null;
}
