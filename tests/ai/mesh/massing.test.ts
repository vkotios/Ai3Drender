import { NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { buildMassing, buildMassingGlb } from '@/lib/ai/mesh/massing';
import { makeComponent, makeFurnitureSpec, makeMaterial } from '../../fixtures';

const io = new NodeIO();

/** Shared layout for the positional tests below: 1000 x 800 x 900mm, seat at 450mm. */
const LAYOUT_SPEC = makeFurnitureSpec({
  dimensions: { widthMm: 1000, depthMm: 800, heightMm: 900 },
  seatHeightMm: 450,
  components: [],
});

function specWith(component: ReturnType<typeof makeComponent>) {
  return { ...LAYOUT_SPEC, components: [component] };
}

describe('buildMassing: component placement by role', () => {
  it('insets four legs from the corners by half their own thickness', () => {
    const spec = specWith(
      makeComponent({ name: 'Legs', role: 'leg', approxSizeMm: { widthMm: 40, depthMm: 40, heightMm: 430 } }),
    );
    const { boxes } = buildMassing(spec);
    expect(boxes).toHaveLength(4);
    expect(boxes.map((b) => b.name)).toEqual(['Legs 1', 'Legs 2', 'Legs 3', 'Legs 4']);

    const x = 0.5 - 0.02; // halfW - w/2
    const z = 0.4 - 0.02; // halfD - d/2
    const y = 0.215; // h/2
    expect(boxes[0].center).toEqual([x, y, z]);
    expect(boxes[1].center).toEqual([-x, y, z]);
    expect(boxes[2].center).toEqual([x, y, -z]);
    expect(boxes[3].center).toEqual([-x, y, -z]);
  });

  it('sits the seat so its top surface is exactly at seatHeightMm', () => {
    const spec = specWith(
      makeComponent({ name: 'Seat', role: 'seat', approxSizeMm: { widthMm: 630, depthMm: 650, heightMm: 100 } }),
    );
    const { boxes } = buildMassing(spec);
    expect(boxes[0].center).toEqual([0, 0.45 - 0.05, 0]);
  });

  it('defaults seat height to 55% of overall height when the spec states none', () => {
    const spec = { ...specWith(makeComponent({ role: 'seat', approxSizeMm: { widthMm: 1, depthMm: 1, heightMm: 100 } })), seatHeightMm: null };
    const { boxes } = buildMassing(spec);
    expect(boxes[0].center[1]).toBeCloseTo(0.9 * 0.55 - 0.05, 6);
  });

  it('places the backrest against the back edge, rising from the seat', () => {
    const spec = specWith(
      makeComponent({ name: 'Backrest', role: 'backrest', approxSizeMm: { widthMm: 630, depthMm: 100, heightMm: 360 } }),
    );
    const { boxes } = buildMassing(spec);
    expect(boxes[0].center).toEqual([0, 0.45 + 0.18, -0.4 + 0.05]);
  });

  it('places two armrests symmetrically at seat height', () => {
    const spec = specWith(
      makeComponent({ name: 'Arms', role: 'armrest', approxSizeMm: { widthMm: 60, depthMm: 400, heightMm: 100 } }),
    );
    const { boxes } = buildMassing(spec);
    expect(boxes).toHaveLength(2);
    const x = 0.5 - 0.03;
    const y = 0.45 + 0.05;
    expect(boxes[0].center).toEqual([x, y, 0]);
    expect(boxes[1].center).toEqual([-x, y, 0]);
  });

  it('places the top flush with the overall height', () => {
    const spec = specWith(makeComponent({ name: 'Top', role: 'top', approxSizeMm: { widthMm: 1000, depthMm: 800, heightMm: 60 } }));
    const { boxes } = buildMassing(spec);
    expect(boxes[0].center).toEqual([0, 0.9 - 0.03, 0]);
  });

  it('centres a shelf at half the overall height, regardless of its own thickness', () => {
    const spec = specWith(makeComponent({ name: 'Shelf', role: 'shelf', approxSizeMm: { widthMm: 900, depthMm: 400, heightMm: 20 } }));
    const { boxes } = buildMassing(spec);
    expect(boxes[0].center).toEqual([0, 0.45, 0]);
  });

  it('splits a panel left/right across the front face', () => {
    const spec = specWith(
      makeComponent({ name: 'Doors', role: 'panel', approxSizeMm: { widthMm: 480, depthMm: 40, heightMm: 800 } }),
    );
    const { boxes } = buildMassing(spec);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].center).toEqual([0.25, 0.45, 0.4 - 0.02]);
    expect(boxes[1].center).toEqual([-0.25, 0.45, 0.4 - 0.02]);
  });

  it('stacks frame/carcass on the shared cursor without advancing it, unlike unmatched roles', () => {
    const spec = {
      ...LAYOUT_SPEC,
      components: [
        makeComponent({ name: 'Base', role: 'unrecognised', approxSizeMm: { widthMm: 50, depthMm: 50, heightMm: 100 } }),
        makeComponent({ name: 'Carcass', role: 'carcass', approxSizeMm: { widthMm: 900, depthMm: 400, heightMm: 200 } }),
        makeComponent({ name: 'Trim', role: 'still-unrecognised', approxSizeMm: { widthMm: 50, depthMm: 50, heightMm: 50 } }),
      ],
    };
    const { boxes } = buildMassing(spec);
    expect(boxes).toHaveLength(3);
    // Unmatched role: y = cursor + h/2, then cursor += h.
    expect(boxes[0].center).toEqual([0, 0.05, 0]);
    // Carcass: y = h/2 + cursor (cursor is still 0.1 - carcass never advances it).
    expect(boxes[1].center).toEqual([0, 0.1 + 0.1, 0]);
    // Next unmatched role resumes from the cursor left by the FIRST unmatched
    // component (0.1), not from where carcass sat.
    expect(boxes[2].center).toEqual([0, 0.1 + 0.025, 0]);
  });

  it('produces one placeholder box spanning the full envelope when the spec has no components', () => {
    const { boxes } = buildMassing({ ...LAYOUT_SPEC, displayName: 'Mystery Piece', components: [] });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      name: 'Mystery Piece',
      center: [0, 0.45, 0],
      size: [1, 0.9, 0.8],
    });
  });

  it('falls back to a default grey material when the spec lists none', () => {
    const { materials } = buildMassing({ ...LAYOUT_SPEC, materials: [] });
    expect(materials).toEqual([{ name: 'default', baseColorHex: '#9a9a9a', metallic: 0, roughness: 0.7 }]);
  });

  it('maps an unknown materialId to material index 0 rather than throwing', () => {
    const spec = {
      ...specWith(makeComponent({ role: 'seat', materialId: 'no-such-material' })),
      materials: [makeMaterial({ id: 'frame' }), makeMaterial({ id: 'upholstery' })],
    };
    const { boxes } = buildMassing(spec);
    expect(boxes[0].materialIndex).toBe(0);
  });

  it('floors dimensions and component sizes so a zero/negative input never yields a degenerate box', () => {
    const spec = {
      ...LAYOUT_SPEC,
      dimensions: { widthMm: 0, depthMm: -5, heightMm: 900 },
      components: [makeComponent({ role: 'seat', approxSizeMm: { widthMm: 0, depthMm: -1, heightMm: 100 } })],
    };
    const { boxes } = buildMassing(spec);
    expect(boxes[0].size[0]).toBeGreaterThanOrEqual(0.01);
    expect(boxes[0].size[2]).toBeGreaterThanOrEqual(0.01);
  });
});

describe('buildMassingGlb: real-world round trip', () => {
  it('produces a mesh whose bounding box matches the spec dimensions, in metres', async () => {
    const spec = { ...LAYOUT_SPEC, components: [] }; // single full-envelope box
    const document = await io.readBinary(buildMassingGlb(spec));
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

    // widthMm=1000 depthMm=800 heightMm=900 -> 1.0 x 0.9 x 0.8m, floor-origin.
    expect(max[0] - min[0]).toBeCloseTo(1.0, 5);
    expect(max[1] - min[1]).toBeCloseTo(0.9, 5);
    expect(max[2] - min[2]).toBeCloseTo(0.8, 5);
    expect(min[1]).toBeCloseTo(0, 5); // resting on the floor
  });

  it('gives every declared material a corresponding glTF material, in spec order', async () => {
    const spec = {
      ...specWith(makeComponent({ role: 'seat', materialId: 'upholstery' })),
      materials: [makeMaterial({ id: 'frame', name: 'Frame material' }), makeMaterial({ id: 'upholstery', name: 'Upholstery material' })],
    };
    const document = await io.readBinary(buildMassingGlb(spec));
    expect(document.getRoot().listMaterials().map((m) => m.getName())).toEqual([
      'Frame material',
      'Upholstery material',
    ]);
  });

  it('names each mesh after its component, numbering repeated parts (e.g. legs)', async () => {
    const spec = specWith(
      makeComponent({ name: 'Legs', role: 'leg', approxSizeMm: { widthMm: 40, depthMm: 40, heightMm: 430 } }),
    );
    const document = await io.readBinary(buildMassingGlb(spec));
    expect(document.getRoot().listMeshes().map((m) => m.getName())).toEqual([
      'Legs 1',
      'Legs 2',
      'Legs 3',
      'Legs 4',
    ]);
  });
});
