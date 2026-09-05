'use client';

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';

export type ExportFormat = 'glb' | 'gltf' | 'obj';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; note: string }[] = [
  { id: 'glb', label: 'GLB', note: 'Single binary file, materials embedded. Best for handoff.' },
  { id: 'gltf', label: 'glTF', note: 'JSON with embedded buffers. Readable and diffable.' },
  { id: 'obj', label: 'OBJ', note: 'Geometry only, no materials. For CAD and CNC round-trips.' },
];

/**
 * Copy the live scene, minus anything that only exists to help the operator.
 *
 * Exporting the viewport object directly would bake the selection cage, the
 * layout grid and the transform gizmo into the delivered file.
 */
function exportableClone(root: THREE.Object3D): THREE.Object3D {
  const copy = root.clone(true);

  const doomed: THREE.Object3D[] = [];
  copy.traverse((child) => {
    if (child.userData?.helper) doomed.push(child);
  });
  // Detach after traversal; mutating the tree mid-traverse skips siblings.
  for (const node of doomed) node.removeFromParent();

  return copy;
}

export interface ExportResult {
  blob: Blob;
  extension: string;
}

export async function exportScene(
  root: THREE.Object3D,
  format: ExportFormat,
): Promise<ExportResult> {
  const scene = exportableClone(root);

  if (format === 'obj') {
    const text = new OBJExporter().parse(scene);
    return { blob: new Blob([text], { type: 'text/plain' }), extension: 'obj' };
  }

  const binary = format === 'glb';
  const output = await new Promise<ArrayBuffer | Record<string, unknown>>((resolve, reject) => {
    new GLTFExporter().parse(
      scene,
      (result) => resolve(result as ArrayBuffer | Record<string, unknown>),
      (error) => reject(new Error(`glTF export failed: ${String(error)}`)),
      { binary, onlyVisible: true, truncateDrawRange: true },
    );
  });

  if (binary) {
    return { blob: new Blob([output as ArrayBuffer], { type: 'model/gltf-binary' }), extension: 'glb' };
  }
  return {
    blob: new Blob([JSON.stringify(output, null, 2)], { type: 'model/gltf+json' }),
    extension: 'gltf',
  };
}

/** Trigger a browser download for an exported scene. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the download a tick to start before releasing the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Grab the current viewport as a PNG. The canvas is created with
 * preserveDrawingBuffer so this reads back a complete frame.
 */
export function captureViewport(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not read the viewport'))),
      'image/png',
    );
  });
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'scene'
  );
}
