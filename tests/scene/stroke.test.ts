import { describe, expect, it } from 'vitest';

import {
  MAX_STROKE_POINTS,
  appendStrokeSample,
  isValidStrokePoints,
  primaryStrokePartName,
  strokeCentroid,
} from '@/lib/scene/stroke';
import { distinctStrokePartNames, formatAnnotationForPrompt } from '@/lib/scene/anchor';

describe('appendStrokeSample', () => {
  it('always keeps the first sample', () => {
    const result = appendStrokeSample([], { point: { x: 0, y: 0, z: 0 }, partName: null }, 0.01);
    expect(result).toEqual([{ point: { x: 0, y: 0, z: 0 }, partName: null }]);
  });

  it('drops a sample closer than the min distance to the last kept one', () => {
    const first = { point: { x: 0, y: 0, z: 0 }, partName: 'Legs 1' };
    const samples = [first];
    const tooClose = { point: { x: 0.001, y: 0, z: 0 }, partName: 'Legs 1' };

    const result = appendStrokeSample(samples, tooClose, 0.01);
    // Same array reference, so a React state setter can skip a re-render.
    expect(result).toBe(samples);
  });

  it('keeps a sample at least the min distance from the last kept one', () => {
    const first = { point: { x: 0, y: 0, z: 0 }, partName: 'Legs 1' };
    const samples = [first];
    const farEnough = { point: { x: 0.02, y: 0, z: 0 }, partName: 'Legs 1' };

    const result = appendStrokeSample(samples, farEnough, 0.01);
    expect(result).toEqual([first, farEnough]);
    expect(result).not.toBe(samples);
  });

  it('measures distance in 3D, not just along one axis', () => {
    // 0.006 on each of x/y/z -> sqrt(3 * 0.006^2) ~= 0.0104, just over 0.01.
    const first = { point: { x: 0, y: 0, z: 0 }, partName: null };
    const samples = [first];
    const diagonal = { point: { x: 0.006, y: 0.006, z: 0.006 }, partName: null };

    expect(appendStrokeSample(samples, diagonal, 0.01)).toEqual([first, diagonal]);
  });
});

describe('strokeCentroid', () => {
  it('returns the origin for an empty stroke', () => {
    expect(strokeCentroid([])).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('averages every sampled point', () => {
    const samples = [
      { point: { x: 0, y: 0, z: 0 } },
      { point: { x: 1, y: 0, z: 0 } },
      { point: { x: 2, y: 0.3, z: -1 } },
    ];
    const centroid = strokeCentroid(samples);
    expect(centroid.x).toBeCloseTo(1);
    expect(centroid.y).toBeCloseTo(0.1);
    expect(centroid.z).toBeCloseTo(-1 / 3);
  });
});

describe('primaryStrokePartName', () => {
  it('returns the first sample that actually hit a named part', () => {
    const samples = [
      { partName: null },
      { partName: null },
      { partName: 'Backrest' },
      { partName: 'Legs 2' },
    ];
    expect(primaryStrokePartName(samples)).toBe('Backrest');
  });

  it('returns null when every sample landed off any named part', () => {
    expect(primaryStrokePartName([{ partName: null }, { partName: null }])).toBeNull();
  });
});

describe('distinctStrokePartNames', () => {
  it('base-names and de-duplicates in first-appearance order', () => {
    const samples = [
      { partName: 'Legs 1' },
      { partName: 'Legs 2' },
      { partName: 'Backrest' },
      { partName: null },
      { partName: 'Legs 3' },
    ];
    expect(distinctStrokePartNames(samples)).toEqual(['Legs', 'Backrest']);
  });

  it('returns an empty list when nothing named was hit', () => {
    expect(distinctStrokePartNames([{ partName: null }])).toEqual([]);
  });
});

describe('isValidStrokePoints', () => {
  const validSample = { point: { x: 0, y: 0, z: 0 }, partName: 'Legs 1' };

  it('rejects anything but an array', () => {
    expect(isValidStrokePoints(null)).toBe(false);
    expect(isValidStrokePoints('nope')).toBe(false);
    expect(isValidStrokePoints({ point: { x: 0, y: 0, z: 0 } })).toBe(false);
  });

  it('rejects a stroke shorter than two points (a tap, not a stroke)', () => {
    expect(isValidStrokePoints([validSample])).toBe(false);
    expect(isValidStrokePoints([])).toBe(false);
  });

  it('accepts a well-formed stroke with a null partName on some samples', () => {
    expect(
      isValidStrokePoints([validSample, { point: { x: 1, y: 0, z: 0 }, partName: null }]),
    ).toBe(true);
  });

  it('rejects a sample with a non-finite point', () => {
    expect(
      isValidStrokePoints([validSample, { point: { x: NaN, y: 0, z: 0 }, partName: null }]),
    ).toBe(false);
    expect(
      isValidStrokePoints([validSample, { point: { x: 0, y: 0 }, partName: null }]),
    ).toBe(false);
  });

  it('rejects a stroke over the point-count ceiling', () => {
    const huge = Array.from({ length: MAX_STROKE_POINTS + 1 }, () => validSample);
    expect(isValidStrokePoints(huge)).toBe(false);
  });

  it('accepts a stroke right at the point-count ceiling', () => {
    const atCeiling = Array.from({ length: MAX_STROKE_POINTS }, () => validSample);
    expect(isValidStrokePoints(atCeiling)).toBe(true);
  });
});

describe('formatAnnotationForPrompt (freehand)', () => {
  it('names the single part a stroke crosses', () => {
    const line = formatAnnotationForPrompt({
      body: 'Shave this whole edge down.',
      partName: 'Legs 1',
      componentName: 'Legs',
      anchorDescription: 'front-left, 180 mm above the floor',
      selectionKind: 'freehand',
      strokePoints: [{ partName: 'Legs 1' }, { partName: 'Legs 2' }],
    });
    expect(line).toBe(
      '- a freehand stroke drawn across the Legs surface (front-left, 180 mm above the floor): Shave this whole edge down.',
    );
  });

  it('names every distinct part a stroke crosses', () => {
    const line = formatAnnotationForPrompt({
      body: 'Blend this seam.',
      partName: 'Backrest',
      componentName: 'Backrest',
      anchorDescription: 'back, 400 mm above the floor',
      selectionKind: 'freehand',
      strokePoints: [{ partName: 'Backrest' }, { partName: 'Armrest 1' }, { partName: 'Armrest 2' }],
    });
    expect(line).toBe(
      '- a freehand stroke drawn across the Backrest and Armrest surfaces (back, 400 mm above the floor): Blend this seam.',
    );
  });

  it('falls back to "the surface" when no sample resolved to a named part', () => {
    const line = formatAnnotationForPrompt({
      body: 'Note.',
      partName: null,
      componentName: null,
      anchorDescription: 'centre, 400 mm above the floor',
      selectionKind: 'freehand',
      strokePoints: [{ partName: null }],
    });
    expect(line).toBe(
      '- a freehand stroke drawn across the surface (centre, 400 mm above the floor): Note.',
    );
  });

  it('is unaffected for a non-freehand annotation with no selectionKind given', () => {
    const line = formatAnnotationForPrompt({
      body: 'Make this slimmer.',
      partName: 'Legs 3',
      componentName: 'Legs',
      anchorDescription: 'front-left, 180 mm above the floor',
    });
    expect(line).toBe('- on the Legs (front-left, 180 mm above the floor): Make this slimmer.');
  });
});
