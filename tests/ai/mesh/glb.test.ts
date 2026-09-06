import { NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { writeGlb, type GlbBox, type GlbMaterial } from '@/lib/ai/mesh/glb';

const io = new NodeIO();

/** One box, one material - the smallest valid input. */
function singleBox(overrides: Partial<GlbBox> = {}): GlbBox[] {
  return [
    {
      name: 'Seat',
      center: [0, 0.5, 0],
      size: [1, 0.2, 0.8],
      materialIndex: 0,
      ...overrides,
    },
  ];
}

const material = (overrides: Partial<GlbMaterial> = {}): GlbMaterial => ({
  name: 'Upholstery',
  baseColorHex: '#8C8778',
  metallic: 0,
  roughness: 0.9,
  ...overrides,
});

describe('writeGlb', () => {
  it('produces a spec-valid .glb that round-trips through gltf-transform', async () => {
    const glb = writeGlb(singleBox(), [material()]);
    const document = await io.readBinary(glb);
    const root = document.getRoot();

    expect(root.listMeshes()).toHaveLength(1);
    expect(root.listMaterials()).toHaveLength(1);
  });

  it('refuses to write an asset with no geometry', () => {
    expect(() => writeGlb([], [material()])).toThrow(/nothing to write/);
  });

  it('names one mesh/node per box, preserving distinct part names', async () => {
    const boxes: GlbBox[] = [
      { name: 'Legs 1', center: [0.4, 0.2, 0.3], size: [0.05, 0.4, 0.05], materialIndex: 0 },
      { name: 'Legs 2', center: [-0.4, 0.2, 0.3], size: [0.05, 0.4, 0.05], materialIndex: 0 },
      { name: 'Seat', center: [0, 0.45, 0], size: [1, 0.1, 0.9], materialIndex: 0 },
    ];
    const document = await io.readBinary(writeGlb(boxes, [material()]));
    const root = document.getRoot();

    // A single multi-primitive mesh would collapse every part into one node
    // named "furniture" - the whole point of one-mesh-per-box is that these
    // names survive into the viewer for annotations and per-part overrides.
    expect(root.listMeshes()).toHaveLength(3);
    expect(root.listNodes().map((n) => n.getName())).toEqual(['Legs 1', 'Legs 2', 'Seat']);
    expect(root.listMeshes().map((m) => m.getName())).toEqual(['Legs 1', 'Legs 2', 'Seat']);
  });

  it('gives every box a closed box mesh: 6 faces, 24 vertices, 12 triangles', async () => {
    const document = await io.readBinary(writeGlb(singleBox(), [material()]));
    const mesh = document.getRoot().listMeshes()[0];
    const prim = mesh.listPrimitives()[0];

    expect(prim.getAttribute('POSITION')!.getCount()).toBe(24); // 6 faces * 4 verts, unshared for flat normals
    expect(prim.getIndices()!.getCount()).toBe(36); // 12 triangles * 3
  });

  it('places geometry so the real-world bounding box matches center +/- size/2', async () => {
    const box: GlbBox = { name: 'Top', center: [0.2, 1, -0.3], size: [2, 0.05, 1], materialIndex: 0 };
    const document = await io.readBinary(writeGlb([box], [material()]));
    const prim = document.getRoot().listMeshes()[0].listPrimitives()[0];
    const position = prim.getAttribute('POSITION')!;

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.getCount(); i += 1) {
      const v = position.getElement(i, []);
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], v[axis]);
        max[axis] = Math.max(max[axis], v[axis]);
      }
    }

    const expectedMin = box.center.map((c, i) => c - box.size[i] / 2);
    const expectedMax = box.center.map((c, i) => c + box.size[i] / 2);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(min[axis]).toBeCloseTo(expectedMin[axis], 6);
      expect(max[axis]).toBeCloseTo(expectedMax[axis], 6);
    }
  });

  it('assigns each box its declared material by index', async () => {
    const boxes: GlbBox[] = [
      { name: 'Frame', center: [0, 0.2, 0], size: [0.1, 0.1, 0.1], materialIndex: 1 },
      { name: 'Seat', center: [0, 0.4, 0], size: [0.5, 0.1, 0.5], materialIndex: 0 },
    ];
    const materials = [material({ name: 'Fabric' }), material({ name: 'Wood', baseColorHex: '#6B4A2F' })];
    const document = await io.readBinary(writeGlb(boxes, materials));
    const [frameMesh, seatMesh] = document.getRoot().listMeshes();

    expect(frameMesh.listPrimitives()[0].getMaterial()?.getName()).toBe('Wood');
    expect(seatMesh.listPrimitives()[0].getMaterial()?.getName()).toBe('Fabric');
  });

  it('converts sRGB hex to linear baseColorFactor, alpha 1', async () => {
    const document = await io.readBinary(writeGlb(singleBox(), [material({ baseColorHex: '#FFFFFF' })]));
    const white = document.getRoot().listMaterials()[0].getBaseColorFactor();
    expect(white[0]).toBeCloseTo(1, 5);
    expect(white[1]).toBeCloseTo(1, 5);
    expect(white[2]).toBeCloseTo(1, 5);
    expect(white[3]).toBe(1);

    const black = await io.readBinary(writeGlb(singleBox(), [material({ baseColorHex: '#000000' })]));
    const blackFactor = black.getRoot().listMaterials()[0].getBaseColorFactor();
    expect(blackFactor[0]).toBeCloseTo(0, 5);
  });

  it('falls back to mid-grey rather than failing on an unparseable colour', async () => {
    const document = await io.readBinary(
      writeGlb(singleBox(), [material({ baseColorHex: 'not-a-colour' })]),
    );
    // hexToRgb's fallback ([0.6, 0.6, 0.6]) is a fixed constant, deliberately
    // not run back through sRGB->linear - vendor/model data reaching this
    // path is untrusted, and the fallback must never itself throw or produce
    // NaN/undefined.
    const [r, g, b] = document.getRoot().listMaterials()[0].getBaseColorFactor();
    expect(r).toBeCloseTo(0.6, 5);
    expect(g).toBeCloseTo(0.6, 5);
    expect(b).toBeCloseTo(0.6, 5);
  });

  it('clamps out-of-range metalness/roughness instead of writing invalid glTF', async () => {
    const document = await io.readBinary(
      writeGlb(singleBox(), [material({ metallic: 5, roughness: -3 })]),
    );
    const mat = document.getRoot().listMaterials()[0];
    expect(mat.getMetallicFactor()).toBe(1);
    expect(mat.getRoughnessFactor()).toBe(0);
  });
});
