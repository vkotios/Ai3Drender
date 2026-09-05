'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GradientEquirectTexture, WebGLPathTracer } from 'three-gpu-pathtracer';

/**
 * Progressive path-traced rendering of the live scene.
 *
 * Mounted only while rendering: a useFrame at priority 1 takes over the render
 * loop from react-three-fiber, so unmounting hands it straight back and the
 * real-time viewport resumes.
 *
 * Accumulation restarts whenever the camera moves, which is what makes this
 * usable interactively - frame the shot roughly, then leave it to converge.
 */
export function PathTracer({
  bounces,
  maxSamples,
  resolutionScale,
  fallbackTopColor,
  fallbackBottomColor,
  onSamples,
}: {
  bounces: number;
  maxSamples: number;
  resolutionScale: number;
  fallbackTopColor: string;
  fallbackBottomColor: string;
  onSamples: (samples: number, converged: boolean) => void;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  const tracerRef = useRef<WebGLPathTracer | null>(null);
  const lastCameraMatrix = useRef(new THREE.Matrix4());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;

    // Path tracing is entirely driven by the environment map. If the HDRI
    // failed to load there is nothing lighting the scene, so stand in a
    // gradient built from the booth's own colours rather than render black.
    const substituteEnvironment = scene.environment ? null : new GradientEquirectTexture(512);
    const originalEnvironment = scene.environment;
    if (substituteEnvironment) {
      substituteEnvironment.topColor.set(fallbackTopColor);
      substituteEnvironment.bottomColor.set(fallbackBottomColor);
      substituteEnvironment.update();
      scene.environment = substituteEnvironment;
    }

    const tracer = new WebGLPathTracer(gl);
    tracer.bounces = bounces;
    tracer.renderScale = resolutionScale;
    // Show something immediately instead of a black frame while the first
    // samples accumulate.
    tracer.dynamicLowRes = true;
    tracer.renderToCanvas = true;
    tracerRef.current = tracer;

    // setScene builds the BVH synchronously. The async variant needs a BVH
    // worker installed via setBVHWorker first, and bundling one buys little
    // here: a staged booth is a handful of meshes, so the build is a short
    // hitch rather than something worth moving off the main thread.
    tracer.setScene(scene, camera);
    if (!disposed) {
      lastCameraMatrix.current.copy(camera.matrixWorld);
      setReady(true);
    }

    return () => {
      disposed = true;
      setReady(false);
      tracerRef.current = null;
      tracer.dispose();
      if (substituteEnvironment) {
        scene.environment = originalEnvironment;
        substituteEnvironment.dispose();
      }
    };
    // Bounces and scale are build-time settings; changing them remounts.
  }, [gl, scene, camera, bounces, resolutionScale, fallbackTopColor, fallbackBottomColor]);

  useFrame(() => {
    const tracer = tracerRef.current;
    if (!tracer || !ready) return;

    // Orbiting invalidates every accumulated sample.
    if (!camera.matrixWorld.equals(lastCameraMatrix.current)) {
      lastCameraMatrix.current.copy(camera.matrixWorld);
      tracer.updateCamera();
    }

    if (tracer.samples < maxSamples) {
      tracer.renderSample();
      onSamples(tracer.samples, false);
    } else {
      onSamples(tracer.samples, true);
    }
  }, 1);

  return null;
}
