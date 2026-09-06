import { describe, expect, it } from 'vitest';

import { describeAnchor, formatAnnotationForPrompt, resolveComponent } from '@/lib/scene/anchor';
import { makeFurnitureSpec } from '../fixtures';

describe('resolveComponent', () => {
  const spec = makeFurnitureSpec({
    components: [
      { name: 'Legs', role: 'leg', materialId: 'frame', approxSizeMm: { widthMm: 40, depthMm: 40, heightMm: 430 } },
      { name: 'Backrest', role: 'backrest', materialId: 'upholstery', approxSizeMm: { widthMm: 600, depthMm: 100, heightMm: 300 } },
    ],
  });

  it('resolves "Legs 3" (an exported, numbered part) back to the "Legs" component', () => {
    expect(resolveComponent('Legs 3', spec)).toEqual({ componentName: 'Legs', componentRole: 'leg' });
  });

  it('resolves an un-numbered exact name match', () => {
    expect(resolveComponent('Backrest', spec)).toEqual({ componentName: 'Backrest', componentRole: 'backrest' });
  });

  it('is case-insensitive and strips a leading-whitespace-padded numeric suffix', () => {
    expect(resolveComponent('  Legs 12', spec)).toEqual({ componentName: 'Legs', componentRole: 'leg' });
  });

  it('falls back to matching by role when no name matches', () => {
    const withRoleOnly = makeFurnitureSpec({
      components: [{ name: 'Custom Part Name', role: 'leg', materialId: 'frame', approxSizeMm: { widthMm: 1, depthMm: 1, heightMm: 1 } }],
    });
    expect(resolveComponent('leg', withRoleOnly)).toEqual({ componentName: 'Custom Part Name', componentRole: 'leg' });
  });

  it('returns nulls for a vendor mesh part that maps to nothing (merged/unnamed geometry)', () => {
    expect(resolveComponent('Object_0042', spec)).toEqual({ componentName: null, componentRole: null });
  });

  it('returns nulls when there is no part name at all', () => {
    expect(resolveComponent(null, spec)).toEqual({ componentName: null, componentRole: null });
  });
});

describe('describeAnchor', () => {
  // 900 x 900mm footprint -> thirds boundary at +/- 150mm = +/- 0.15m.
  const dimensions = { widthMm: 900, depthMm: 900, heightMm: 800 };

  it('collapses dead-centre to "centre" rather than the ugly "centre-middle"', () => {
    expect(describeAnchor({ x: 0, y: 0.2, z: 0 }, dimensions)).toBe('centre, 200 mm above the floor');
  });

  it('collapses centre-front to just "front"', () => {
    expect(describeAnchor({ x: 0, y: 0, z: 0.2 }, dimensions)).toBe('front, 0 mm above the floor');
  });

  it('collapses centre-back to just "back"', () => {
    expect(describeAnchor({ x: 0, y: 0, z: -0.2 }, dimensions)).toBe('back, 0 mm above the floor');
  });

  it('collapses left-middle to just "left"', () => {
    expect(describeAnchor({ x: -0.2, y: 0, z: 0 }, dimensions)).toBe('left, 0 mm above the floor');
  });

  it('collapses right-middle to just "right"', () => {
    expect(describeAnchor({ x: 0.2, y: 0, z: 0 }, dimensions)).toBe('right, 0 mm above the floor');
  });

  it('names a genuine corner as "<longitudinal>-<lateral>"', () => {
    expect(describeAnchor({ x: -0.2, y: 0.18, z: 0.2 }, dimensions)).toBe('front-left, 180 mm above the floor');
    expect(describeAnchor({ x: 0.2, y: 0, z: -0.2 }, dimensions)).toBe('back-right, 0 mm above the floor');
  });

  it('treats points within the thirds boundary as centre/middle, not nudged to a side', () => {
    // Just inside +/- widthM/6: genuinely near the middle should stay there.
    expect(describeAnchor({ x: 0.14, y: 0, z: 0.14 }, dimensions)).toBe('centre, 0 mm above the floor');
  });

  it('reports height in millimetres, rounded', () => {
    expect(describeAnchor({ x: 0, y: 0.1234, z: 0 }, dimensions)).toBe('centre, 123 mm above the floor');
  });
});

describe('formatAnnotationForPrompt', () => {
  it('prefers the resolved component name over the raw mesh part name', () => {
    const line = formatAnnotationForPrompt({
      body: 'Make this slimmer.',
      partName: 'Legs 3',
      componentName: 'Legs',
      anchorDescription: 'front-left, 180 mm above the floor',
    });
    expect(line).toBe('- on the Legs (front-left, 180 mm above the floor): Make this slimmer.');
  });

  it('falls back to the raw part name, then to just the anchor, when unresolved', () => {
    const withPartOnly = formatAnnotationForPrompt({
      body: 'Note.',
      partName: 'Object_0042',
      componentName: null,
      anchorDescription: 'centre, 400 mm above the floor',
    });
    expect(withPartOnly).toBe('- on the Object_0042 (centre, 400 mm above the floor): Note.');

    const withNeither = formatAnnotationForPrompt({
      body: 'Note.',
      partName: null,
      componentName: null,
      anchorDescription: 'centre, 400 mm above the floor',
    });
    expect(withNeither).toBe('- at centre, 400 mm above the floor: Note.');
  });
});
