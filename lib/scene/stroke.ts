import type { StrokePoint, Vec3 } from '@/lib/types';

/**
 * Freehand stroke sampling and anchoring (issue #63).
 *
 * A stroke is captured the same way a single pin is: every sample is
 * raycast against the mesh and stored as a local-space point plus whatever
 * part it landed on - see `Annotation.strokePoints` and `AssetNode`'s
 * pointer handlers. There is no new anchoring scheme here, only an ordered
 * list of the existing point anchor, which is what lets a stroke be redrawn
 * along the same silhouette regardless of camera angle.
 */

/**
 * Server-side ceiling on a stroke's point count - defence in depth against a
 * malformed or hostile request, not a limit a real drag ever approaches: a
 * mouse throttled at a sane min-distance across a piece a few metres across
 * produces at most a few hundred samples.
 */
export const MAX_STROKE_POINTS = 2000;

/** A stroke this short isn't a drawn line, just a tap - the 'point' selection kind already covers that. */
export const MIN_STROKE_POINTS = 2;

/**
 * Append a newly sampled point to a stroke in progress, dropping it if it
 * falls within `minDistanceM` of the last kept sample.
 *
 * Called on every pointer-move while drawing, so without this a slow drag
 * across a piece a few metres across would accumulate thousands of nearly
 * identical points. Returns the very same array reference when the sample
 * is dropped, so a caller storing this in React state can skip a re-render.
 */
export function appendStrokeSample(
  samples: StrokePoint[],
  next: StrokePoint,
  minDistanceM: number,
): StrokePoint[] {
  const last = samples[samples.length - 1];
  if (last) {
    const dx = next.point.x - last.point.x;
    const dy = next.point.y - last.point.y;
    const dz = next.point.z - last.point.z;
    if (dx * dx + dy * dy + dz * dz < minDistanceM * minDistanceM) return samples;
  }
  return [...samples, next];
}

/**
 * The stroke's centroid, in the same local space as every sample.
 *
 * Used only to place the pin marker and as the anchor carried forward across
 * a version revision - exactly like a whole-part selection's centroid, never
 * a spot the user actually pointed at.
 */
export function strokeCentroid(samples: { point: Vec3 }[]): Vec3 {
  if (samples.length === 0) return { x: 0, y: 0, z: 0 };
  const sum = samples.reduce(
    (acc, s) => ({ x: acc.x + s.point.x, y: acc.y + s.point.y, z: acc.z + s.point.z }),
    { x: 0, y: 0, z: 0 },
  );
  return { x: sum.x / samples.length, y: sum.y / samples.length, z: sum.z / samples.length };
}

/**
 * The first part the stroke actually touched - the raw mesh part name, same
 * convention as a 'point' selection's `partName`. Null if every sample
 * landed off any named part (an unnamed, merged vendor mesh).
 */
export function primaryStrokePartName(samples: { partName: string | null }[]): string | null {
  return samples.find((s) => s.partName)?.partName ?? null;
}

const isFiniteVec3 = (value: unknown): value is Vec3 =>
  typeof value === 'object' &&
  value !== null &&
  ['x', 'y', 'z'].every((axis) => Number.isFinite((value as Record<string, unknown>)[axis]));

/**
 * Validate a freehand stroke as sent from the client: an ordered array of
 * `{ point, partName }` samples, long enough to be a stroke rather than a
 * tap, and short enough that nothing hostile can smuggle an unbounded
 * payload through the annotation routes.
 */
export function isValidStrokePoints(value: unknown): value is StrokePoint[] {
  return (
    Array.isArray(value) &&
    value.length >= MIN_STROKE_POINTS &&
    value.length <= MAX_STROKE_POINTS &&
    value.every((sample) => {
      if (typeof sample !== 'object' || sample === null) return false;
      const { point, partName } = sample as { point?: unknown; partName?: unknown };
      return isFiniteVec3(point) && (typeof partName === 'string' || partName === null);
    })
  );
}
