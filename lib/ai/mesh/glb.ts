/**
 * Minimal glTF 2.0 / GLB writer.
 *
 * Only what the massing generator needs: axis-aligned boxes with flat normals
 * and PBR metallic-roughness materials. Output is a spec-valid single-file .glb
 * that loads in three.js, Blender, Windows 3D Viewer and every online viewer.
 *
 * glTF is Y-up, right-handed, metres.
 */

export interface GlbBox {
  name: string;
  /** Centre of the box, in metres. */
  center: [number, number, number];
  /** Full extents, in metres. */
  size: [number, number, number];
  materialIndex: number;
}

export interface GlbMaterial {
  name: string;
  baseColorHex: string;
  metallic: number;
  roughness: number;
}

const FLOATS_PER_VERTEX = 3;

/** Unit cube corners, grouped per face so each face gets its own flat normal. */
const FACES: { normal: [number, number, number]; corners: [number, number, number][] }[] = [
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];

/** sRGB hex -> linear RGB, glTF's base colour space. Shared with `rebake.ts`. */
export function hexToRgb(hex: string | undefined): [number, number, number] {
  // Vendor and model data reaches here unvalidated; a bad colour must not
  // abort the whole export.
  const m = hex ? /^#?([0-9a-f]{6})$/i.exec(hex.trim()) : null;
  if (!m) return [0.6, 0.6, 0.6];
  const n = parseInt(m[1], 16);
  // glTF base colours are linear; source hex is sRGB.
  const toLinear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return [
    toLinear(((n >> 16) & 255) / 255),
    toLinear(((n >> 8) & 255) / 255),
    toLinear((n & 255) / 255),
  ];
}

/** Round a byte length up to the next 4-byte boundary, as glTF requires. */
const align4 = (n: number) => (n + 3) & ~3;

export function writeGlb(boxes: GlbBox[], materials: GlbMaterial[]): Uint8Array {
  if (boxes.length === 0) throw new Error('writeGlb: nothing to write');

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  interface Primitive {
    firstVertex: number;
    vertexCount: number;
    firstIndex: number;
    indexCount: number;
    min: [number, number, number];
    max: [number, number, number];
    materialIndex: number;
    name: string;
  }
  const primitives: Primitive[] = [];

  for (const box of boxes) {
    const firstVertex = positions.length / FLOATS_PER_VERTEX;
    const firstIndex = indices.length;
    const [hx, hy, hz] = [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    for (const face of FACES) {
      const base = positions.length / FLOATS_PER_VERTEX;
      for (const [cx, cy, cz] of face.corners) {
        const v: [number, number, number] = [
          box.center[0] + cx * hx,
          box.center[1] + cy * hy,
          box.center[2] + cz * hz,
        ];
        positions.push(v[0], v[1], v[2]);
        normals.push(...face.normal);
        for (let axis = 0; axis < 3; axis += 1) {
          if (v[axis] < min[axis]) min[axis] = v[axis];
          if (v[axis] > max[axis]) max[axis] = v[axis];
        }
      }
      // Two triangles per quad, wound counter-clockwise when seen from outside.
      const local = base - firstVertex;
      indices.push(local, local + 1, local + 2, local, local + 2, local + 3);
    }

    primitives.push({
      firstVertex,
      vertexCount: positions.length / FLOATS_PER_VERTEX - firstVertex,
      firstIndex,
      indexCount: indices.length - firstIndex,
      min,
      max,
      materialIndex: box.materialIndex,
      name: box.name,
    });
  }

  const positionBytes = new Float32Array(positions);
  const normalBytes = new Float32Array(normals);
  const indexBytes = new Uint32Array(indices);

  const positionOffset = 0;
  const normalOffset = align4(positionBytes.byteLength);
  const indexOffset = align4(normalOffset + normalBytes.byteLength);
  const binLength = align4(indexOffset + indexBytes.byteLength);

  const bin = new Uint8Array(binLength);
  bin.set(new Uint8Array(positionBytes.buffer), positionOffset);
  bin.set(new Uint8Array(normalBytes.buffer), normalOffset);
  bin.set(new Uint8Array(indexBytes.buffer), indexOffset);

  // Three shared buffer views; accessors slice per primitive with byteOffset.
  const bufferViews = [
    { buffer: 0, byteOffset: positionOffset, byteLength: positionBytes.byteLength, target: 34962 },
    { buffer: 0, byteOffset: normalOffset, byteLength: normalBytes.byteLength, target: 34962 },
    { buffer: 0, byteOffset: indexOffset, byteLength: indexBytes.byteLength, target: 34963 },
  ];

  const accessors: Record<string, unknown>[] = [];
  // One mesh (and one node) per box, named after the component it came from.
  // A single multi-primitive mesh would collapse every part into one object
  // called "furniture", which loses the names that surface annotations and
  // per-part material overrides in the studio.
  const meshes = primitives.map((p) => {
    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: 0,
      byteOffset: p.firstVertex * 3 * 4,
      componentType: 5126, // FLOAT
      count: p.vertexCount,
      type: 'VEC3',
      min: p.min,
      max: p.max,
    });
    const normalAccessor = accessors.length;
    accessors.push({
      bufferView: 1,
      byteOffset: p.firstVertex * 3 * 4,
      componentType: 5126,
      count: p.vertexCount,
      type: 'VEC3',
    });
    const indexAccessor = accessors.length;
    accessors.push({
      bufferView: 2,
      byteOffset: p.firstIndex * 4,
      componentType: 5125, // UNSIGNED_INT
      count: p.indexCount,
      type: 'SCALAR',
    });
    return {
      name: p.name,
      primitives: [
        {
          attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
          indices: indexAccessor,
          material: p.materialIndex,
        },
      ],
    };
  });

  const gltf = {
    asset: { version: '2.0', generator: 'ai3drender massing generator' },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, index) => index) }],
    nodes: meshes.map((mesh, index) => ({ mesh: index, name: mesh.name })),
    meshes,
    materials: materials.map((m) => {
      const [r, g, b] = hexToRgb(m.baseColorHex);
      return {
        name: m.name,
        pbrMetallicRoughness: {
          baseColorFactor: [r, g, b, 1],
          metallicFactor: Math.min(1, Math.max(0, m.metallic)),
          roughnessFactor: Math.min(1, Math.max(0, m.roughness)),
        },
        doubleSided: false,
      };
    }),
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  const jsonRaw = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonLength = align4(jsonRaw.byteLength);
  const jsonChunk = Buffer.alloc(jsonLength, 0x20); // pad JSON with spaces
  jsonRaw.copy(jsonChunk);

  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4; // 'glTF'
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonLength, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4; // 'JSON'
  jsonChunk.copy(out, o); o += jsonLength;
  out.writeUInt32LE(binLength, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4; // 'BIN\0'
  Buffer.from(bin).copy(out, o);

  return new Uint8Array(out);
}
