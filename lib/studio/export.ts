'use client';

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { MaterialSpec, SceneNode } from '@/lib/types';

import { applyMaterialOverrides } from './applyMaterialOverrides';
import { fetchBlobUrl } from './blobUrl';

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

interface FullMeshTag {
  fullMeshPath: string;
  materialOverrides: SceneNode['materialOverrides'];
  specMaterials: readonly MaterialSpec[];
}

/**
 * `AssetNode.tsx` tags the group it fits/offsets a mesh into with this,
 * whenever the viewport is showing that asset's decimated preview mesh
 * (see issue #47) - `fullMeshPath` names the full-detail mesh a delivered
 * export should carry instead.
 */
function readFullMeshTag(userData: Record<string, unknown>): FullMeshTag | null {
  if (typeof userData.fullMeshPath !== 'string') return null;
  return {
    fullMeshPath: userData.fullMeshPath,
    materialOverrides: (userData.materialOverrides as SceneNode['materialOverrides'] | undefined) ?? {},
    specMaterials: (userData.specMaterials as MaterialSpec[] | undefined) ?? [],
  };
}

/**
 * Swap every decimated preview mesh under `root` for a freshly loaded
 * full-detail one, so an exported file never ships the lighter viewport
 * geometry (issue #47) - the Blender render worker gets its full-detail mesh
 * straight from storage server-side and never touches this.
 *
 * Best-effort per node: a mesh that fails to (re)load - a stale signed URL,
 * a network hiccup - is left as the preview rather than aborting the export
 * outright, on the theory that a slightly-lower-detail file beats none.
 */
async function upgradeToFullDetailMeshes(root: THREE.Object3D): Promise<void> {
  const targets: { group: THREE.Object3D; tag: FullMeshTag }[] = [];
  root.traverse((child) => {
    const tag = readFullMeshTag(child.userData);
    if (tag) targets.push({ group: child, tag });
  });
  if (targets.length === 0) return;

  const loader = new GLTFLoader();
  await Promise.all(
    targets.map(async ({ group, tag }) => {
      try {
        const { url } = await fetchBlobUrl(tag.fullMeshPath);
        const gltf = await loader.loadAsync(url);
        applyMaterialOverrides(gltf.scene, tag.materialOverrides, tag.specMaterials);
        for (const child of [...group.children]) group.remove(child);
        for (const child of [...gltf.scene.children]) group.add(child);
      } catch (error) {
        console.warn(
          `Could not load the full-detail mesh for export, keeping the preview instead: ${tag.fullMeshPath}`,
          error,
        );
      }
    }),
  );
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
  await upgradeToFullDetailMeshes(scene);

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
