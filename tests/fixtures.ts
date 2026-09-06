import type { FurnitureComponent, FurnitureSpec, MaterialSpec } from '@/lib/types';

/** A minimal but valid material, only overriding what a test cares about. */
export function makeMaterial(overrides: Partial<MaterialSpec> = {}): MaterialSpec {
  return {
    id: 'frame',
    name: 'Solid timber frame',
    kind: 'wood',
    baseColorHex: '#8B5A2B',
    roughness: 0.55,
    metalness: 0,
    sheen: 0,
    clearcoat: 0.25,
    finish: 'oiled',
    notes: '',
    ...overrides,
  };
}

export function makeComponent(overrides: Partial<FurnitureComponent> = {}): FurnitureComponent {
  return {
    name: 'Legs',
    role: 'leg',
    materialId: 'frame',
    approxSizeMm: { widthMm: 40, depthMm: 40, heightMm: 430 },
    ...overrides,
  };
}

/** A lounge chair with one component of every role the massing generator special-cases. */
export function makeFurnitureSpec(overrides: Partial<FurnitureSpec> = {}): FurnitureSpec {
  return {
    displayName: 'Lounge Chair',
    category: 'lounge chair',
    summary: 'Test fixture chair.',
    dimensions: { widthMm: 700, depthMm: 720, heightMm: 800 },
    seatHeightMm: 440,
    dimensionConfidence: 'stated',
    components: [
      makeComponent({ name: 'Legs', role: 'leg', approxSizeMm: { widthMm: 40, depthMm: 40, heightMm: 440 } }),
      makeComponent({ name: 'Seat', role: 'seat', approxSizeMm: { widthMm: 630, depthMm: 650, heightMm: 100 } }),
      makeComponent({
        name: 'Backrest',
        role: 'backrest',
        approxSizeMm: { widthMm: 630, depthMm: 100, heightMm: 360 },
      }),
    ],
    materials: [makeMaterial()],
    palette: ['#8B5A2B'],
    styleTags: ['contemporary'],
    symmetry: 'bilateral',
    reconstructionNotes: '',
    ...overrides,
  };
}
