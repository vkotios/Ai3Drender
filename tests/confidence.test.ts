import { describe, expect, it } from 'vitest';

import { assessSpecConfidence } from '@/lib/confidence';
import { makeFurnitureSpec, makeMaterial } from './fixtures';

describe('assessSpecConfidence', () => {
  it('is high when dimensions are stated and no material was invented', () => {
    const spec = makeFurnitureSpec({
      dimensionConfidence: 'stated',
      materials: [makeMaterial({ invented: false }), makeMaterial({ id: 'accent', invented: false })],
    });
    const signal = assessSpecConfidence(spec);
    expect(signal.tier).toBe('high');
    expect(signal.label).toBe('High confidence');
    expect(signal.reasons).toEqual([]);
  });

  it('is medium when dimensions are only estimated', () => {
    const spec = makeFurnitureSpec({
      dimensionConfidence: 'estimated',
      materials: [makeMaterial({ invented: false })],
    });
    const signal = assessSpecConfidence(spec);
    expect(signal.tier).toBe('medium');
    expect(signal.reasons).toHaveLength(1);
    expect(signal.reasons[0]).toMatch(/estimated/i);
  });

  it('is low when dimensions fall back to category conventions - the offline stub path', () => {
    const spec = makeFurnitureSpec({
      dimensionConfidence: 'rough',
      materials: [makeMaterial({ invented: false })],
    });
    expect(assessSpecConfidence(spec).tier).toBe('low');
  });

  it('degrades stated dimensions to medium when some materials were invented', () => {
    const spec = makeFurnitureSpec({
      dimensionConfidence: 'stated',
      materials: [
        makeMaterial({ id: 'frame', invented: false }),
        makeMaterial({ id: 'accent', invented: true }),
      ],
    });
    const signal = assessSpecConfidence(spec);
    expect(signal.tier).toBe('medium');
    expect(signal.reasons.some((r) => /1 of 2 materials was invented/.test(r))).toBe(true);
  });

  it('degrades stated dimensions all the way to low when every material was invented', () => {
    const spec = makeFurnitureSpec({
      dimensionConfidence: 'stated',
      materials: [makeMaterial({ invented: true })],
    });
    expect(assessSpecConfidence(spec).tier).toBe('low');
  });

  it('never upgrades a rough dimension tier just because materials all matched the library', () => {
    const spec = makeFurnitureSpec({
      dimensionConfidence: 'rough',
      materials: [makeMaterial({ invented: false })],
    });
    expect(assessSpecConfidence(spec).tier).toBe('low');
  });

  it('treats an absent invented flag the same as false (specs recorded before the field existed)', () => {
    const material = makeMaterial();
    delete (material as { invented?: boolean }).invented;
    const spec = makeFurnitureSpec({ dimensionConfidence: 'stated', materials: [material] });
    expect(assessSpecConfidence(spec).tier).toBe('high');
  });

  it('gives a non-empty summary even at high confidence, for the badge tooltip', () => {
    const spec = makeFurnitureSpec({
      dimensionConfidence: 'stated',
      materials: [makeMaterial({ invented: false })],
    });
    expect(assessSpecConfidence(spec).summary.length).toBeGreaterThan(0);
  });
});
