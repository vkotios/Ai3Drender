/**
 * First-pass interference detection between staged pieces (issue #49).
 *
 * Deliberately scoped to axis-aligned bounding box (AABB) overlap, not
 * mesh-level collision - see `docs/competitive-gap-analysis.md` §04. Each
 * staged node's box is transformed into world space (position, rotation,
 * scale all applied) before pairs are compared, so a rotated piece is caught
 * correctly rather than only in its own local axes.
 *
 * This runs entirely client-side, off the in-memory `SceneDoc` and whatever
 * asset versions are already loaded - no server round-trip, no mesh fetch.
 * It is advisory only: callers surface the result as a warning, never as a
 * block on Save.
 */
import * as THREE from 'three';

import { PROP_DEFINITIONS } from './presets';
import type { AssetVersion, SceneDoc, SceneNode, Uuid } from '@/lib/types';

export interface AABB {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * What this module needs from a loaded asset version, keyed by
 * `SceneNode.assetVersionId`. Structurally compatible with
 * `Record<Uuid, LoadedVersion>` from `lib/studio/store` - accepted by shape
 * rather than imported, so this module (usable from plain tests) never has
 * to depend on the studio store.
 */
export type VersionLookup = Record<Uuid, { version: Pick<AssetVersion, 'spec'> } | undefined>;

/**
 * A staged node's real-world footprint and height, in metres, before its own
 * transform (position/rotation/scale) is applied.
 *
 * Both a massed asset and a prop are authored centred on the X/Z origin and
 * grounded at y=0 (see `AssetNode.tsx`'s `offset` and `PropNode.tsx`'s
 * `position={[0, h / 2, 0]}`), so that convention is reused here rather than
 * re-deriving it from a loaded mesh - keeping this a pure function of the
 * scene doc and the spec data already in memory.
 */
export function localFootprint(node: SceneNode, versions: VersionLookup): { width: number; height: number; depth: number } | null {
  if (node.kind === 'asset') {
    if (!node.assetVersionId) return null;
    const loaded = versions[node.assetVersionId];
    if (!loaded) return null;
    const { widthMm, depthMm, heightMm } = loaded.version.spec.dimensions;
    return { width: widthMm / 1000, depth: depthMm / 1000, height: heightMm / 1000 };
  }
  if (node.kind === 'prop') {
    if (!node.propKind) return null;
    const [width, height, depth] = PROP_DEFINITIONS[node.propKind].size;
    return { width, height, depth };
  }
  // Lights have no physical footprint to collide with.
  return null;
}

/**
 * The node's local box (centred in X/Z, grounded at y=0) carried through its
 * transform into world space.
 */
export function worldAABB(
  node: SceneNode,
  footprint: { width: number; height: number; depth: number },
): AABB {
  const { width, height, depth } = footprint;
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(node.transform.position.x, node.transform.position.y, node.transform.position.z),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(node.transform.rotation.x, node.transform.rotation.y, node.transform.rotation.z, 'XYZ'),
    ),
    new THREE.Vector3(node.transform.scale.x, node.transform.scale.y, node.transform.scale.z),
  );

  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  // All 8 corners, not just the two opposite ones - a rotated box's world
  // extent cannot be recovered from just its min/max corners.
  for (const sx of [-width / 2, width / 2]) {
    for (const sy of [0, height]) {
      for (const sz of [-depth / 2, depth / 2]) {
        box.expandByPoint(corner.set(sx, sy, sz).applyMatrix4(matrix));
      }
    }
  }
  return { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
}

function overlaps(a: AABB, b: AABB): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

interface StagedBox {
  id: string;
  box: AABB;
}

/** Every staged (visible, sizeable) node's world-space AABB. */
function stagedBoxes(doc: SceneDoc, versions: VersionLookup): StagedBox[] {
  const boxes: StagedBox[] = [];
  for (const node of doc.nodes) {
    if (!node.visible) continue;
    const footprint = localFootprint(node, versions);
    if (!footprint) continue;
    boxes.push({ id: node.id, box: worldAABB(node, footprint) });
  }
  return boxes;
}

/** Every pair of staged nodes whose world-space AABBs overlap. */
export function findOverlappingPairs(doc: SceneDoc, versions: VersionLookup): Array<[string, string]> {
  const boxes = stagedBoxes(doc, versions);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i].box, boxes[j].box)) pairs.push([boxes[i].id, boxes[j].id]);
    }
  }
  return pairs;
}

/**
 * Names of every other staged node whose bounding box overlaps `node`'s -
 * what the Inspector shows as a per-node warning. Empty when the node is
 * hidden, has nothing to size it (e.g. an asset whose version has not
 * loaded), or simply does not overlap anything.
 */
export function overlappingNodeNames(node: SceneNode, doc: SceneDoc, versions: VersionLookup): string[] {
  if (!node.visible) return [];
  const footprint = localFootprint(node, versions);
  if (!footprint) return [];
  const box = worldAABB(node, footprint);

  const names: string[] = [];
  for (const other of doc.nodes) {
    if (other.id === node.id || !other.visible) continue;
    const otherFootprint = localFootprint(other, versions);
    if (!otherFootprint) continue;
    if (overlaps(box, worldAABB(other, otherFootprint))) names.push(other.name);
  }
  return names;
}
