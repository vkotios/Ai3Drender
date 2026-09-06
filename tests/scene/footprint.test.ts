import { describe, expect, it } from 'vitest';

import {
  MAX_FOOTPRINT_POINTS,
  MIN_FOOTPRINT_POINTS,
  footprintBounds,
  footprintPointFromImageFraction,
  isValidFootprintBoundary,
  triangulatePolygon,
  wallSegmentPlacement,
  wallsFromBoundary,
} from '@/lib/scene/footprint';
import type { FootprintPoint } from '@/lib/types';

/** Twice the signed area (shoelace formula) of a closed polygon. */
function shoelaceArea(points: FootprintPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

function triangleArea(a: FootprintPoint, b: FootprintPoint, c: FootprintPoint): number {
  return Math.abs((a.x - c.x) * (b.z - c.z) - (b.x - c.x) * (a.z - c.z)) / 2;
}

/** Every triangle's area should sum to the whole polygon's - true for a convex or a simple concave polygon alike. */
function totalTriangulatedArea(boundary: FootprintPoint[]): number {
  return triangulatePolygon(boundary).reduce(
    (sum, [i, j, k]) => sum + triangleArea(boundary[i], boundary[j], boundary[k]),
    0,
  );
}

const square: FootprintPoint[] = [
  { x: 0, z: 0 },
  { x: 4, z: 0 },
  { x: 4, z: 3 },
  { x: 0, z: 3 },
];

// An L-shape (concave, one reflex vertex) - a 4x4 square with a 2x2 notch cut from one corner.
const lShape: FootprintPoint[] = [
  { x: 0, z: 0 },
  { x: 4, z: 0 },
  { x: 4, z: 2 },
  { x: 2, z: 2 },
  { x: 2, z: 4 },
  { x: 0, z: 4 },
];

describe('isValidFootprintBoundary', () => {
  it('rejects fewer than MIN_FOOTPRINT_POINTS', () => {
    expect(isValidFootprintBoundary([{ x: 0, z: 0 }, { x: 1, z: 0 }])).toBe(false);
  });

  it('accepts exactly MIN_FOOTPRINT_POINTS', () => {
    expect(isValidFootprintBoundary(square.slice(0, MIN_FOOTPRINT_POINTS))).toBe(true);
  });

  it('rejects more than MAX_FOOTPRINT_POINTS', () => {
    const tooMany = Array.from({ length: MAX_FOOTPRINT_POINTS + 1 }, (_, i) => ({ x: i, z: 0 }));
    expect(isValidFootprintBoundary(tooMany)).toBe(false);
  });

  it('rejects a non-finite point', () => {
    expect(isValidFootprintBoundary([...square, { x: NaN, z: 0 }])).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(isValidFootprintBoundary(null)).toBe(false);
    expect(isValidFootprintBoundary(undefined)).toBe(false);
  });
});

describe('footprintBounds', () => {
  it('measures a simple rectangle', () => {
    expect(footprintBounds(square)).toEqual({ width: 4, depth: 3, centerX: 2, centerZ: 1.5 });
  });

  it('measures the bounding box of a concave shape, not its true footprint', () => {
    // The L-shape's bounding box is the full 4x4 square it was cut from.
    expect(footprintBounds(lShape)).toEqual({ width: 4, depth: 4, centerX: 2, centerZ: 2 });
  });
});

describe('triangulatePolygon', () => {
  it('returns one triangle for a triangle', () => {
    const triangle = square.slice(0, 3);
    expect(triangulatePolygon(triangle)).toEqual([[0, 1, 2]]);
  });

  it('covers the whole area of a convex quad', () => {
    expect(totalTriangulatedArea(square)).toBeCloseTo(shoelaceArea(square));
  });

  it('covers the whole area of a concave (L-shaped) polygon', () => {
    expect(totalTriangulatedArea(lShape)).toBeCloseTo(shoelaceArea(lShape));
  });

  it('produces n-2 triangles for a simple n-gon', () => {
    expect(triangulatePolygon(square)).toHaveLength(square.length - 2);
    expect(triangulatePolygon(lShape)).toHaveLength(lShape.length - 2);
  });

  it('triangulates regardless of winding order', () => {
    const reversed = [...square].reverse();
    expect(totalTriangulatedArea(reversed)).toBeCloseTo(shoelaceArea(square));
  });

  it('returns nothing for fewer than 3 points', () => {
    expect(triangulatePolygon([{ x: 0, z: 0 }, { x: 1, z: 0 }])).toEqual([]);
  });
});

describe('wallSegmentPlacement', () => {
  it('centres and measures a segment along +X', () => {
    const placement = wallSegmentPlacement({ start: { x: 0, z: 0 }, end: { x: 4, z: 0 }, open: false });
    expect(placement.centerX).toBeCloseTo(2);
    expect(placement.centerZ).toBeCloseTo(0);
    expect(placement.length).toBeCloseTo(4);
    expect(placement.rotationY).toBeCloseTo(0);
  });

  it('derives a rotation that aligns local +X with the wall direction', () => {
    // A 3-4-5 triangle's hypotenuse, so the expected direction is exactly (0.6, 0.8).
    const wall = { start: { x: 0, z: 0 }, end: { x: 3, z: 4 }, open: false };
    const placement = wallSegmentPlacement(wall);
    expect(placement.length).toBeCloseTo(5);
    // Rotating the local +X axis by rotationY about Y (three.js's convention,
    // matched by lib/render/gltf-math.ts's eulerXYZToQuaternion) lands at
    // (cos(rotationY), -sin(rotationY)) in the XZ plane - see Booth.tsx and
    // lib/render/build-scene.ts, which both apply this the same way.
    expect(Math.cos(placement.rotationY)).toBeCloseTo(3 / 5);
    expect(-Math.sin(placement.rotationY)).toBeCloseTo(4 / 5);
  });
});

describe('wallsFromBoundary', () => {
  it('produces one closed wall per edge, wrapping back to the first point', () => {
    const walls = wallsFromBoundary(square);
    expect(walls).toHaveLength(square.length);
    expect(walls.every((w) => !w.open)).toBe(true);
    expect(walls[walls.length - 1].end).toEqual(square[0]);
    walls.forEach((wall, i) => {
      expect(wall.start).toEqual(square[i]);
      expect(wall.end).toEqual(square[(i + 1) % square.length]);
    });
  });
});

describe('footprintPointFromImageFraction', () => {
  it('maps the image centre to the booth origin', () => {
    expect(footprintPointFromImageFraction(0.5, 0.5, 8, 6)).toEqual({ x: 0, z: 0 });
  });

  it('maps left/right to -X/+X and top/bottom to -Z/+Z, scaled by the given size', () => {
    expect(footprintPointFromImageFraction(0, 0.5, 8, 6)).toEqual({ x: -4, z: 0 });
    expect(footprintPointFromImageFraction(1, 0.5, 8, 6)).toEqual({ x: 4, z: 0 });
    expect(footprintPointFromImageFraction(0.5, 0, 8, 6)).toEqual({ x: 0, z: -3 });
    expect(footprintPointFromImageFraction(0.5, 1, 8, 6)).toEqual({ x: 0, z: 3 });
  });

  it('clamps an out-of-range fraction instead of extrapolating past the image', () => {
    expect(footprintPointFromImageFraction(-0.2, 1.5, 8, 6)).toEqual({ x: -4, z: 3 });
  });

  it('treats a non-finite fraction as the centre', () => {
    expect(footprintPointFromImageFraction(NaN, 0.5, 8, 6)).toEqual({ x: 0, z: 0 });
  });
});
