import { Accessor, Buffer as GltfBuffer, Document, Material, Node } from '@gltf-transform/core';

/**
 * Axis-aligned box authoring, direct on a gltf-transform Document.
 *
 * Same geometry convention as `lib/ai/mesh/glb.ts` (one flat-normal quad per
 * face, so each box reads correctly under a single directional light) but
 * built straight through the Document API instead of hand-rolled binary, so
 * it can sit in the same document as merged-in asset meshes without a
 * serialise/reparse round trip. Kept as its own small table here rather than
 * imported from glb.ts to keep that module's writer self-contained and this
 * one free of a cross-module coupling for eight numbers.
 */
const FACES: { normal: [number, number, number]; corners: [number, number, number][] }[] = [
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];

/** One shared buffer for every box built into a document, created lazily. */
function sharedBuffer(document: Document): GltfBuffer {
  const existing = document.getRoot().listBuffers()[0];
  if (existing) return existing;
  return document.createBuffer();
}

export interface BoxSpec {
  name: string;
  /** Full extents, metres. */
  size: [number, number, number];
  /** Centre of the box in its own local space - callers place it via the parent Node's transform. */
  center?: [number, number, number];
}

export interface BoxMaterialSpec {
  name: string;
  baseColorHex: string;
  roughness: number;
  metalness: number;
}

function hexToLinear(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x999999;
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [
    toLinear(((n >> 16) & 255) / 255),
    toLinear(((n >> 8) & 255) / 255),
    toLinear((n & 255) / 255),
  ];
}

export function createBoxMaterial(document: Document, spec: BoxMaterialSpec): Material {
  const [r, g, b] = hexToLinear(spec.baseColorHex);
  return document
    .createMaterial(spec.name)
    .setBaseColorFactor([r, g, b, 1])
    .setRoughnessFactor(Math.min(1, Math.max(0, spec.roughness)))
    .setMetallicFactor(Math.min(1, Math.max(0, spec.metalness)))
    .setDoubleSided(false);
}

/** Build a standalone box mesh + node (not yet attached to any Scene). */
export function createBoxNode(document: Document, box: BoxSpec, material: Material): Node {
  const [sx, sy, sz] = box.size;
  const [cx, cy, cz] = box.center ?? [0, 0, 0];
  const [hx, hy, hz] = [sx / 2, sy / 2, sz / 2];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const face of FACES) {
    const base = positions.length / 3;
    for (const [x, y, z] of face.corners) {
      positions.push(cx + x * hx, cy + y * hy, cz + z * hz);
      normals.push(...face.normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const buffer = sharedBuffer(document);
  const position = document
    .createAccessor(`${box.name} position`)
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const normal = document
    .createAccessor(`${box.name} normal`)
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array(normals))
    .setBuffer(buffer);
  const index = document
    .createAccessor(`${box.name} index`)
    .setType(Accessor.Type.SCALAR)
    .setArray(new Uint32Array(indices))
    .setBuffer(buffer);

  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setIndices(index)
    .setMaterial(material);

  const mesh = document.createMesh(box.name).addPrimitive(primitive);
  return document.createNode(box.name).setMesh(mesh);
}
