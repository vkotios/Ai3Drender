import { describe, expect, it } from 'vitest';

import { offlineFurnitureSpec, offlineSceneDirection } from '@/lib/ai/offline';

const HEX = /^#[0-9a-f]{6}$/i;

describe('offlineFurnitureSpec', () => {
  it('is deterministic for the same filenames', () => {
    const a = offlineFurnitureSpec(['sofa-01.jpg', 'sofa-02.jpg']);
    const b = offlineFurnitureSpec(['sofa-01.jpg', 'sofa-02.jpg']);
    expect(a).toEqual(b);
  });

  it('picks the category profile matching a keyword in the filenames', () => {
    expect(offlineFurnitureSpec(['dining-table-01.jpg']).category).toBe('dining table');
    expect(offlineFurnitureSpec(['oak-sideboard.png']).category).toBe('sideboard');
    expect(offlineFurnitureSpec(['random-file.jpg']).category).toBe('lounge chair'); // FALLBACK
  });

  /**
   * The internal 32-bit FNV hash used to pick a deterministic wood/textile
   * tone is unsigned by design (`h >>> 0`). This is exactly the class of bug
   * that once produced undefined material colours: without the unsigned
   * shift, `Math.imul` can return a negative 32-bit int, and a negative
   * dividend in `seed % TONES.length` indexes the tone array with a negative
   * number - `TONES[-2]` is `undefined`, not a wrapped-around positive index.
   *
   * This sweeps enough distinct filenames to hit a hash whose top bit is set
   * (i.e. would be negative if the sign were preserved) deterministically,
   * rather than relying on one lucky input.
   */
  it('always produces defined, valid hex colours for every material (guards the signed-hash class of bug)', () => {
    for (let i = 0; i < 500; i += 1) {
      const spec = offlineFurnitureSpec([`piece-${i}.jpg`, `detail-${i}.jpg`]);
      expect(spec.materials.length).toBeGreaterThan(0);
      for (const material of spec.materials) {
        expect(material.baseColorHex).toEqual(expect.stringMatching(HEX));
      }
      expect(spec.palette.every((hex) => HEX.test(hex))).toBe(true);
    }
  });

  it('marks every field as rough/offline rather than pretending to have measured it', () => {
    const spec = offlineFurnitureSpec(['chair.jpg']);
    expect(spec.dimensionConfidence).toBe('rough');
    expect(spec.summary).toMatch(/offline/i);
  });

  it('only includes an upholstery material for profiles that use one', () => {
    const table = offlineFurnitureSpec(['console-table.jpg']);
    expect(table.materials.some((m) => m.id === 'upholstery')).toBe(false);

    const sofa = offlineFurnitureSpec(['sofa.jpg']);
    expect(sofa.materials.some((m) => m.id === 'upholstery')).toBe(true);
  });

  it('gives every component a materialId that resolves to a real material', () => {
    const spec = offlineFurnitureSpec(['bed.jpg']);
    const ids = new Set(spec.materials.map((m) => m.id));
    for (const component of spec.components) {
      expect(ids.has(component.materialId)).toBe(true);
    }
  });
});

describe('offlineSceneDirection', () => {
  it('names the pieces in the rationale and returns valid palette hexes', () => {
    const direction = offlineSceneDirection(['Lounge Chair', 'Side Table']);
    expect(direction.rationale).toMatch(/Lounge Chair, Side Table/);
    expect(direction.paletteHex.every((hex) => HEX.test(hex))).toBe(true);
  });
});
