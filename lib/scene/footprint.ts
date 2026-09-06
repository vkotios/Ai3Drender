import type { FootprintPoint, FootprintWall } from '@/lib/types';

/**
 * Traced-footprint geometry (issue #52 Phase A - "reference underlay +
 * manual trace", see docs/proposals/cad-floor-plan-import.md).
 *
 * No three.js here, same reason lib/render/gltf-math.ts has none: this
 * module is shared by the live viewport (components/studio/Booth.tsx) and
 * the server-side glTF/Blender export path (lib/render/build-scene.ts),
 * which has no live three.js instance to build one against - see that
 * file's own header comment. Keeping the polygon math in one place is what
 * makes a traced booth render identically in both places.
 */

/** A polygon this short cannot enclose any floor area. */
export const MIN_FOOTPRINT_POINTS = 3;

/**
 * Server-side ceiling on a traced boundary's point count - defence in depth,
 * mirrors MAX_STROKE_POINTS in lib/scene/stroke.ts. A booth boundary traced
 * by hand against an underlay rarely needs more than a few dozen vertices.
 */
export const MAX_FOOTPRINT_POINTS = 200;

const isFiniteFootprintPoint = (value: unknown): value is FootprintPoint =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as Record<string, unknown>).x) &&
  Number.isFinite((value as Record<string, unknown>).z);

/** Whether a boundary is worth rendering: enough points, every one a finite number. */
export function isValidFootprintBoundary(
  boundary: readonly FootprintPoint[] | null | undefined,
): boundary is FootprintPoint[] {
  return (
    Array.isArray(boundary) &&
    boundary.length >= MIN_FOOTPRINT_POINTS &&
    boundary.length <= MAX_FOOTPRINT_POINTS &&
    boundary.every(isFiniteFootprintPoint)
  );
}

export interface FootprintBounds {
  width: number;
  depth: number;
  centerX: number;
  centerZ: number;
}

/** Axis-aligned bounding box of a boundary, in the same booth-local XZ metres. */
export function footprintBounds(boundary: readonly FootprintPoint[]): FootprintBounds {
  const xs = boundary.map((p) => p.x);
  const zs = boundary.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return {
    width: maxX - minX,
    depth: maxZ - minZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

/**
 * Twice the signed area of a closed polygon (the shoelace formula) -
 * positive for a counter-clockwise boundary, negative for clockwise. The
 * sign only matters internally, to keep `triangulatePolygon`'s convexity
 * test consistent regardless of which way the user happened to click around
 * the shape; what actually renders is double-sided (see
 * `lib/render/polygon-mesh.ts` and Booth.tsx's floor material), so winding
 * never affects what's visible.
 */
function signedArea2(boundary: readonly FootprintPoint[]): number {
  let sum = 0;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i];
    const b = boundary[(i + 1) % boundary.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum;
}

function cross(o: FootprintPoint, a: FootprintPoint, b: FootprintPoint): number {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

/** Whether `p` lies inside (or exactly on the edge of) triangle a-b-c, independent of winding. */
function pointInTriangle(
  p: FootprintPoint,
  a: FootprintPoint,
  b: FootprintPoint,
  c: FootprintPoint,
): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple (non-self-intersecting) polygon.
 *
 * Returns index triples into `boundary`, in whatever winding order the
 * boundary itself came in. A self-intersecting input - nothing stops a
 * hand-traced polygon from crossing itself - may come back with fewer
 * triangles than a well-formed polygon would produce: the loop below stops
 * the moment it can no longer find a valid ear, rather than looping forever,
 * so a bad trace degrades to a partial floor instead of hanging the
 * renderer.
 */
export function triangulatePolygon(boundary: readonly FootprintPoint[]): [number, number, number][] {
  const n = boundary.length;
  if (n < MIN_FOOTPRINT_POINTS) return [];
  if (n === 3) return [[0, 1, 2]];

  const orientation = signedArea2(boundary) >= 0 ? 1 : -1;
  let remaining = boundary.map((_, i) => i);
  const triangles: [number, number, number][] = [];

  // Worst case is O(n^2) iterations (an ear removed on nearly every pass)
  // times an O(n) containment check per candidate ear; n is capped at
  // MAX_FOOTPRINT_POINTS so this never runs long even in the worst case.
  let guard = n * n;
  while (remaining.length > 3 && guard-- > 0) {
    let removedAnEar = false;
    for (let i = 0; i < remaining.length; i++) {
      const iPrev = remaining[(i - 1 + remaining.length) % remaining.length];
      const iCur = remaining[i];
      const iNext = remaining[(i + 1) % remaining.length];
      const a = boundary[iPrev];
      const b = boundary[iCur];
      const c = boundary[iNext];

      if (cross(a, b, c) * orientation <= 0) continue; // reflex vertex - not a candidate ear tip.

      const containsAnotherVertex = remaining.some(
        (idx) =>
          idx !== iPrev && idx !== iCur && idx !== iNext && pointInTriangle(boundary[idx], a, b, c),
      );
      if (containsAnotherVertex) continue;

      triangles.push([iPrev, iCur, iNext]);
      remaining = remaining.filter((idx) => idx !== iCur);
      removedAnEar = true;
      break;
    }
    if (!removedAnEar) break; // self-intersecting input - stop with a partial triangulation.
  }
  if (remaining.length === 3) triangles.push([remaining[0], remaining[1], remaining[2]]);
  return triangles;
}

export interface WallPlacement {
  centerX: number;
  centerZ: number;
  /** Metres, along the wall's own run. */
  length: number;
  /** Rotation about Y, radians - aligns a box's local +X axis with the wall's direction. */
  rotationY: number;
}

/** Where and how long a wall segment's box should be, from its traced endpoints. */
export function wallSegmentPlacement(wall: FootprintWall): WallPlacement {
  const dx = wall.end.x - wall.start.x;
  const dz = wall.end.z - wall.start.z;
  return {
    centerX: (wall.start.x + wall.end.x) / 2,
    centerZ: (wall.start.z + wall.end.z) / 2,
    length: Math.hypot(dx, dz),
    rotationY: Math.atan2(-dz, dx),
  };
}

/**
 * One closed wall run per boundary edge - the default a trace populates as
 * soon as the boundary is finished, before any edge is opened up as an
 * aisle in the inspector (mirroring how the fixed-rectangle model starts
 * every wall built and lets the operator open individual sides).
 */
export function wallsFromBoundary(boundary: readonly FootprintPoint[]): FootprintWall[] {
  return boundary.map((start, i) => ({
    start,
    end: boundary[(i + 1) % boundary.length],
    open: false,
  }));
}
