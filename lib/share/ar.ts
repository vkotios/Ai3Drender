/**
 * Re-scale and ground one asset version's stored mesh into a standalone,
 * AR-ready GLB.
 *
 * The stored `.glb` a mesh provider writes is not necessarily in real-world
 * scale or grounded at y=0 - `AssetNode.tsx` (viewport) and
 * `lib/render/build-scene.ts` (server-side scene export) both correct for
 * that with the same "fit + offset" rule before the mesh ever shares a scene
 * with anything else. A `<model-viewer>` AR session has no scene graph to
 * place a raw mesh into, so this applies that identical correction on its own
 * to produce a single self-contained document - one piece, not the whole
 * multi-asset scene `build-scene.ts` assembles for renders.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, unpartition } from '@gltf-transform/functions';

export interface ArMeshSource {
  /** The stored .glb bytes for this AssetVersion. */
  glb: Uint8Array;
  /** AssetVersion.meshExtentMm - already real-world scale when set. */
  meshExtentMm: number | null;
  /** max(widthMm, depthMm, heightMm) / 1000 from the version's FurnitureSpec. */
  targetLongestM: number;
}

/**
 * Build a GLB scaled to real-world metres and grounded so its lowest point
 * sits at y=0 - what a phone AR session needs to place the piece at its true
 * size, unlike the raw provider mesh which may be in arbitrary units around
 * an arbitrary origin.
 */
export async function buildArGlb(mesh: ArMeshSource): Promise<Uint8Array> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(mesh.glb);

  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new Error('stored mesh has no scene');

  // Measure in the mesh's own local space, before any scaling - mirrors
  // AssetNode.tsx's `new THREE.Box3().setFromObject(root)` on the raw import.
  const { min, max } = getBounds(scene);
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longestAxis = Math.max(size[0], size[1], size[2]) || 1;

  // meshExtentMm set means the provider already returned real-world units (the
  // massing generator does); null means unit-normalised, so fit it to the
  // spec's dimensions - identical rule to AssetNode.tsx / build-scene.ts.
  const fit = mesh.meshExtentMm === null ? mesh.targetLongestM / longestAxis : 1;
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const offset: [number, number, number] = [-center[0] * fit, -min[1] * fit, -center[2] * fit];

  // Wrap the mesh's existing top-level nodes in a node carrying the fit/offset,
  // rather than baking the transform into vertex data - cheaper, and it keeps
  // this a plain TRS node exactly like the viewport and build-scene.ts use.
  const children = scene.listChildren();
  const wrapper = document.createNode('ar-root').setTranslation(offset).setScale([fit, fit, fit]);
  for (const child of children) wrapper.addChild(child);
  scene.addChild(wrapper);

  // A merged/re-read document may carry more than one Buffer; a .glb may only
  // ever contain one.
  await document.transform(unpartition());

  const bytes = await io.writeBinary(document);
  // Re-parse: readBinary throws on a structurally invalid glTF, which is the
  // validation gltf-transform gives us without a separate validator package -
  // matches writeAndValidateGlb in lib/render/build-scene.ts.
  await io.readBinary(bytes);
  return bytes;
}
