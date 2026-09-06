/**
 * Decimated "preview" copy of a reconstructed mesh, for the real-time studio
 * viewport (and, since it shares the same live three.js scene, the in-browser
 * path tracer) - see issue #47. The Blender render worker and glTF/OBJ export
 * both read `AssetVersion.meshPath` directly and never touch this module, so
 * they keep rendering/exporting the full-detail mesh unconditionally.
 *
 * Follows gltf-transform's documented simplification recipe: `dedup` to merge
 * any bitwise-identical accessors/materials the source mesh duplicated, then
 * `simplify` (which welds internally before collapsing edges) via the
 * meshoptimizer WASM simplifier.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, getSceneVertexCount, simplify, VertexCountMethod, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * Error tolerance passed to the simplifier, as a fraction of mesh radius.
 * Loose enough to meaningfully decimate real vendor scans, tight enough that
 * a hard-edged massing box (which has no slack to give without changing its
 * silhouette) is correctly left alone rather than visibly distorted.
 */
const SIMPLIFY_ERROR = 0.01;

export interface PreviewMeshResult {
  /** The decimated .glb, ready to store. */
  glb: Uint8Array;
  /** Render vertex count (see VertexCountMethod.RENDER) before simplification. */
  sourceVertexCount: number;
  /** Render vertex count after simplification. */
  previewVertexCount: number;
}

/**
 * Produce a decimated copy of `glb`, targeting `ratio` of its render vertex
 * count (0-1, see `env.viewportMeshSimplifyRatio`).
 *
 * Returns `null` - rather than a mesh no lighter than the input - when there
 * is nothing worth keeping: the source is not a readable glTF, has no scene
 * or geometry, or the simplifier declined to reduce it at all (small,
 * already-minimal meshes like the massing generator's boxes commonly land
 * here). Callers should fall back to the full-detail mesh in that case; see
 * `components/studio/AssetNode.tsx`.
 */
export async function createPreviewMesh(
  glb: Uint8Array,
  ratio: number,
): Promise<PreviewMeshResult | null> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

  let document: Document;
  try {
    document = await io.readBinary(glb);
  } catch {
    return null;
  }

  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) return null;

  const sourceVertexCount = getSceneVertexCount(scene, VertexCountMethod.RENDER);
  if (sourceVertexCount === 0) return null;

  try {
    await document.transform(
      dedup(),
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio, error: SIMPLIFY_ERROR }),
    );
  } catch {
    return null;
  }

  const previewVertexCount = getSceneVertexCount(scene, VertexCountMethod.RENDER);
  if (previewVertexCount === 0 || previewVertexCount >= sourceVertexCount) return null;

  let previewGlb: Uint8Array;
  try {
    previewGlb = await io.writeBinary(document);
  } catch {
    return null;
  }

  return { glb: previewGlb, sourceVertexCount, previewVertexCount };
}
