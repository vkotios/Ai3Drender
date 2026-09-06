import { Accessor, Buffer as GltfBuffer, Document, Material, Node } from '@gltf-transform/core';

import { triangulatePolygon } from '@/lib/scene/footprint';
import type { FootprintPoint } from '@/lib/types';

/**
 * A flat polygon floor authored directly on a gltf-transform Document, for a
 * traced footprint boundary (issue #52 Phase A). Same authoring style as
 * lib/render/box-mesh.ts (built straight through the Document API so it can
 * sit in the same document as merged-in asset meshes with no serialise/
 * reparse round trip) but for an arbitrary triangulated polygon rather than
 * a box.
 */

/** One shared buffer for every mesh built into a document - mirrors box-mesh.ts's sharedBuffer. */
function sharedBuffer(document: Document): GltfBuffer {
  const existing = document.getRoot().listBuffers()[0];
  if (existing) return existing;
  return document.createBuffer();
}

/**
 * Build a standalone floor mesh + node from a traced boundary, in the XZ
 * plane at y=0 - not yet attached to any Scene. Returns null when the
 * boundary can't be triangulated at all (fewer than 3 points, or every
 * candidate ear rejected as self-intersecting).
 */
export function createPolygonFloorNode(
  document: Document,
  name: string,
  boundary: readonly FootprintPoint[],
  material: Material,
): Node | null {
  const triangles = triangulatePolygon(boundary);
  if (triangles.length === 0) return null;

  const positions = new Float32Array(boundary.length * 3);
  const normals = new Float32Array(boundary.length * 3);
  boundary.forEach((p, i) => {
    positions.set([p.x, 0, p.z], i * 3);
    normals.set([0, 1, 0], i * 3);
  });
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach(([a, b, c], i) => indices.set([a, b, c], i * 3));

  const buffer = sharedBuffer(document);
  const position = document
    .createAccessor(`${name} position`)
    .setType(Accessor.Type.VEC3)
    .setArray(positions)
    .setBuffer(buffer);
  const normal = document
    .createAccessor(`${name} normal`)
    .setType(Accessor.Type.VEC3)
    .setArray(normals)
    .setBuffer(buffer);
  const index = document
    .createAccessor(`${name} index`)
    .setType(Accessor.Type.SCALAR)
    .setArray(indices)
    .setBuffer(buffer);

  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setIndices(index)
    .setMaterial(material);

  const mesh = document.createMesh(name).addPrimitive(primitive);
  return document.createNode(name).setMesh(mesh);
}
