import { NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { writeGlb, type GlbBox, type GlbMaterial } from '@/lib/ai/mesh/glb';
import { rebakePartMaterial } from '@/lib/ai/mesh/rebake';

const io = new NodeIO();

const WOOD: GlbMaterial = { name: 'Solid timber frame', baseColorHex: '#8B5A2B', metallic: 0, roughness: 0.55 };
const FABRIC: GlbMaterial = { name: 'Wool-blend upholstery', baseColorHex: '#5C6670', metallic: 0, roughness: 0.9 };

/** Four legs sharing WOOD, and one seat on FABRIC - shaped like `buildMassing`'s output. */
function chairGlb(): Uint8Array {
  const boxes: GlbBox[] = [
    { name: 'Legs 1', center: [0.3, 0.2, 0.3], size: [0.05, 0.4, 0.05], materialIndex: 0 },
    { name: 'Legs 2', center: [-0.3, 0.2, 0.3], size: [0.05, 0.4, 0.05], materialIndex: 0 },
    { name: 'Legs 3', center: [0.3, 0.2, -0.3], size: [0.05, 0.4, 0.05], materialIndex: 0 },
    { name: 'Legs 4', center: [-0.3, 0.2, -0.3], size: [0.05, 0.4, 0.05], materialIndex: 0 },
    { name: 'Seat', center: [0, 0.45, 0], size: [0.6, 0.1, 0.6], materialIndex: 1 },
  ];
  return writeGlb(boxes, [WOOD, FABRIC]);
}

describe('rebakePartMaterial', () => {
  it('repaints every instance of the targeted part and leaves the rest byte-identical', async () => {
    const glb = chairGlb();
    const result = await rebakePartMaterial(glb, ['Legs'], {
      name: 'Blackened steel accent',
      baseColorHex: '#2A2A2D',
      roughness: 0.42,
      metalness: 1,
    });

    expect(result.matchedNames.sort()).toEqual(['Legs 1', 'Legs 2', 'Legs 3', 'Legs 4']);

    const document = await io.readBinary(result.glb);
    const meshes = new Map(document.getRoot().listMeshes().map((m) => [m.getName(), m]));

    for (const legName of ['Legs 1', 'Legs 2', 'Legs 3', 'Legs 4']) {
      const material = meshes.get(legName)!.listPrimitives()[0].getMaterial()!;
      expect(material.getName()).toBe('Blackened steel accent');
      expect(material.getMetallicFactor()).toBe(1);
      expect(material.getRoughnessFactor()).toBeCloseTo(0.42, 5);
    }

    // The untargeted Seat kept its own, original material entirely.
    const seatMaterial = meshes.get('Seat')!.listPrimitives()[0].getMaterial()!;
    expect(seatMaterial.getName()).toBe('Wool-blend upholstery');
    expect(seatMaterial.getMetallicFactor()).toBe(0);
    expect(seatMaterial.getRoughnessFactor()).toBeCloseTo(0.9, 5);
  });

  it('the four legs still share one material object after the rebake, not four separate clones', async () => {
    const document = await io.readBinary(
      (
        await rebakePartMaterial(chairGlb(), ['Legs'], {
          name: 'New',
          baseColorHex: '#111111',
          roughness: 0.5,
          metalness: 0,
        })
      ).glb,
    );
    const materials = document
      .getRoot()
      .listMeshes()
      .filter((m) => m.getName().startsWith('Legs'))
      .map((m) => m.listPrimitives()[0].getMaterial());
    expect(new Set(materials).size).toBe(1);
  });

  it('prunes the original material once every user of it has been rebaked away from it', async () => {
    // Every leg shares WOOD and nothing else does - after rebaking "Legs",
    // WOOD has no primitives left pointing at it.
    const document = await io.readBinary(
      (
        await rebakePartMaterial(chairGlb(), ['Legs'], {
          name: 'New',
          baseColorHex: '#111111',
          roughness: 0.5,
          metalness: 0,
        })
      ).glb,
    );
    expect(document.getRoot().listMaterials().map((m) => m.getName())).not.toContain('Solid timber frame');
  });

  it('matches case-insensitively and by base name, ignoring the trailing instance number', async () => {
    const result = await rebakePartMaterial(chairGlb(), ['legs'], {
      name: 'New',
      baseColorHex: '#111111',
      roughness: 0.5,
      metalness: 0,
    });
    expect(result.matchedNames).toHaveLength(4);
  });

  it('returns the input unchanged, with an empty matchedNames, when nothing matches', async () => {
    const glb = chairGlb();
    const result = await rebakePartMaterial(glb, ['Armrest'], {
      name: 'New',
      baseColorHex: '#111111',
      roughness: 0.5,
      metalness: 0,
    });
    expect(result.matchedNames).toEqual([]);
    expect(result.glb).toBe(glb);
  });

  it('clears any baked texture on the rebaked material so the new factor is not multiplied by a stale bake', async () => {
    const document = await io.readBinary(chairGlb());
    const seatMaterial = document
      .getRoot()
      .listMeshes()
      .find((m) => m.getName() === 'Seat')!
      .listPrimitives()[0]
      .getMaterial()!;
    const texture = document.createTexture('stub').setMimeType('image/png').setImage(new Uint8Array([0]));
    seatMaterial.setBaseColorTexture(texture);
    const glbWithTexture = await io.writeBinary(document);

    const rebaked = await rebakePartMaterial(glbWithTexture, ['Seat'], {
      name: 'New',
      baseColorHex: '#123456',
      roughness: 0.3,
      metalness: 0,
    });
    const rebakedDoc = await io.readBinary(rebaked.glb);
    const rebakedSeat = rebakedDoc
      .getRoot()
      .listMeshes()
      .find((m) => m.getName() === 'Seat')!
      .listPrimitives()[0]
      .getMaterial()!;
    expect(rebakedSeat.getBaseColorTexture()).toBeNull();
  });
});
