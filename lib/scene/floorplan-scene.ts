/**
 * Turning a `FloorPlanSceneProposal` (issue #58's vision-model, or offline,
 * output - see `generateSceneFromFloorPlan` in lib/ai/gemini.ts) into a real
 * `SceneDoc`: a traced footprint plus staged furniture, built entirely from
 * `lib/scene/defaults.ts`'s node constructors so the result is
 * indistinguishable from one a person built by hand with issue #52's manual
 * trace and the ordinary "Add a piece" panel (`components/studio/Outliner.tsx`).
 *
 * Pure and synchronous - no store access, no Gemini call - so it is trivially
 * unit-testable and reusable from both the `floorplan_scene` pipeline stage
 * and tests, the same reason `lib/scene/command.ts`'s `applySceneMutations`
 * is split out this way.
 */
import { findOverlappingPairs, localFootprint, overlappingNodeNames, type VersionLookup } from './collisions';
import { createAssetNode, createPropNode, createSceneDoc, defaultCamera } from './defaults';
import {
  MIN_FOOTPRINT_POINTS,
  footprintBounds,
  isValidFootprintBoundary,
  wallsFromBoundary,
  type FootprintBounds,
} from './footprint';
import { PROP_DEFINITIONS } from './presets';
import type {
  AssetVersion,
  FloorPlanPlacementSuggestion,
  FloorPlanSceneProposal,
  FootprintPoint,
  FurnitureAsset,
  PropKind,
  SceneDoc,
  SceneNode,
  Vec3,
} from '@/lib/types';

/**
 * A default width to assume for the reference image when the model could not
 * read a reliable scale off the plan itself (no printed dimension or scale
 * bar) - the same 8m `FloorPlanPanel` (`components/studio/Inspector.tsx`)
 * defaults its own manual width field to, and the default preset's own
 * `boothWidth` (see `lib/scene/presets.ts`'s `base`). Not a measurement, just
 * a plausible trade-show booth size to start from - same as a manual trace,
 * the operator can always fix the scale afterward by re-tracing or
 * re-uploading with the real width.
 */
export const DEFAULT_ASSUMED_WIDTH_M = 8;
const MIN_ASSUMED_WIDTH_M = 1;
const MAX_ASSUMED_WIDTH_M = 40;

/**
 * Resolve the reference image's real-world size from the model's (possibly
 * absent, or implausible) width guess and the image's own pixel aspect ratio
 * - mirrors `FloorPlanPanel`'s `heightM = widthM * (naturalHeight /
 * naturalWidth)` so an auto-generated underlay scales exactly the way a
 * manually uploaded one does.
 */
export function resolveScaleM(
  widthMGuess: number | null | undefined,
  imageWidthPx: number,
  imageHeightPx: number,
): { widthM: number; heightM: number } {
  const guess = Number.isFinite(widthMGuess) && (widthMGuess as number) > 0 ? (widthMGuess as number) : DEFAULT_ASSUMED_WIDTH_M;
  const widthM = Math.min(MAX_ASSUMED_WIDTH_M, Math.max(MIN_ASSUMED_WIDTH_M, guess));
  const aspect = imageWidthPx > 0 && imageHeightPx > 0 ? imageHeightPx / imageWidthPx : 1;
  return { widthM, heightM: widthM * aspect };
}

/** One project asset offered as a placement candidate - its current, finished version. */
export interface FloorPlanAssetCandidate {
  asset: FurnitureAsset;
  version: AssetVersion;
}

export interface BuildFloorPlanSceneResult {
  doc: SceneDoc;
  /** One line per placement dropped, or reporting a residual overlap - surfaced to the operator alongside the new stand. */
  warnings: string[];
}

const RAD_PER_DEG = Math.PI / 180;
/**
 * Extra clearance a nudge aims for beyond the two footprints' combined
 * half-extent, so a nudge actually clears a same-sized neighbour instead of
 * just grazing its edge.
 */
const NUDGE_CLEARANCE_M = 0.2;
/** Rings of compass offsets tried, each ring's step a multiple of the placement's own footprint - a handful of tries, not a solver (see this module's own header comment). */
const NUDGE_RINGS = 3;

const PROP_KINDS = Object.keys(PROP_DEFINITIONS) as PropKind[];

function safeMetres(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function defaultRectangleBoundary(widthM: number, heightM: number): FootprintPoint[] {
  const halfW = widthM / 2;
  const halfH = heightM / 2;
  return [
    { x: -halfW, z: -halfH },
    { x: halfW, z: -halfH },
    { x: halfW, z: halfH },
    { x: -halfW, z: halfH },
  ];
}

/** Case-insensitive exact match against a candidate's display name - mirrors `resolveNodeByName` in lib/scene/command.ts. */
function resolveCandidate(
  name: string | null,
  candidates: readonly FloorPlanAssetCandidate[],
): FloorPlanAssetCandidate | null {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  return (
    candidates.find((c) => (c.asset.name || c.version.spec.displayName).trim().toLowerCase() === target) ?? null
  );
}

/** Keep a placement's centre inside the boundary's bounding box, given its own footprint. Falls back to dead centre if the box is too small to fit it at all. */
function clampToBounds(position: Vec3, bounds: FootprintBounds, halfWidth: number, halfDepth: number): Vec3 {
  const minX = bounds.centerX - bounds.width / 2 + halfWidth;
  const maxX = bounds.centerX + bounds.width / 2 - halfWidth;
  const minZ = bounds.centerZ - bounds.depth / 2 + halfDepth;
  const maxZ = bounds.centerZ + bounds.depth / 2 - halfDepth;
  return {
    x: minX <= maxX ? Math.min(maxX, Math.max(minX, position.x)) : bounds.centerX,
    y: position.y,
    z: minZ <= maxZ ? Math.min(maxZ, Math.max(minZ, position.z)) : bounds.centerZ,
  };
}

/** Build one placement's node (unplaced - transform still the identity), or a plain-language reason it could not be resolved. */
function createNodeForPlacement(
  placement: FloorPlanPlacementSuggestion,
  candidates: readonly FloorPlanAssetCandidate[],
): { node: SceneNode; version: AssetVersion | null } | { problem: string } {
  const candidate = resolveCandidate(placement.assetName, candidates);
  if (candidate) {
    const name = placement.name?.trim() || candidate.asset.name || candidate.version.spec.displayName;
    return { node: createAssetNode(candidate.version, name), version: candidate.version };
  }

  const propKind = PROP_KINDS.find((k) => k === placement.propKind) ?? null;
  if (propKind) {
    const name = placement.name?.trim() || PROP_DEFINITIONS[propKind].label;
    return { node: createPropNode(propKind, name), version: null };
  }

  const label = placement.assetName ?? placement.name ?? placement.propKind ?? 'a suggested piece';
  return { problem: `Could not place "${label}": no matching piece on this project, and no known prop kind either - skipped.` };
}

/**
 * Try a small, fixed set of positions around a placement's suggested spot
 * until one clears every node already accepted into `doc` - a basic nudge,
 * not a solver: an outward ring of compass offsets, one ring further out
 * each lap, up to `NUDGE_RINGS`. Each ring's step is scaled to the node's own
 * footprint (see `NUDGE_CLEARANCE_M`) rather than a fixed distance, since a
 * step that clears a rug would do nothing for a wardrobe - and vice versa.
 * Returns the node repositioned to the first clear spot found, or null if
 * none of the tried spots worked (the caller drops the placement and warns
 * rather than shipping an overlap).
 */
function placeClearOfAccepted(
  node: SceneNode,
  doc: SceneDoc,
  versions: VersionLookup,
  bounds: FootprintBounds,
): SceneNode | null {
  const footprint = localFootprint(node, versions);
  const halfWidth = (footprint?.width ?? 0) / 2;
  const halfDepth = (footprint?.depth ?? 0) / 2;
  const base = node.transform.position;
  const step = Math.max(halfWidth, halfDepth) * 2 + NUDGE_CLEARANCE_M;

  const offsets: Array<[number, number]> = [[0, 0]];
  for (let ring = 1; ring <= NUDGE_RINGS; ring++) {
    const d = ring * step;
    offsets.push([d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]);
  }

  for (const [dx, dz] of offsets) {
    const position = clampToBounds({ x: base.x + dx, y: base.y, z: base.z + dz }, bounds, halfWidth, halfDepth);
    const candidate: SceneNode = { ...node, transform: { ...node.transform, position } };
    const probe: SceneDoc = { ...doc, nodes: [...doc.nodes, candidate] };
    if (overlappingNodeNames(candidate, probe, versions).length === 0) return candidate;
  }
  return null;
}

/**
 * Build a fresh `SceneDoc` from a floor-plan scene proposal: a traced
 * footprint (falling back to a plain rectangle if the suggested boundary
 * isn't usable - see `isValidFootprintBoundary`), plus every placement that
 * resolved to a real asset or prop, nudged clear of anything it would
 * otherwise land on top of. `floorPlanImagePath`, when given, is set as the
 * footprint's underlay (same shape and placement a manual upload gives it -
 * see `FloorPlanUnderlay`), so the result opens in the studio exactly like a
 * manually traced one and issue #52's tools work on it unchanged.
 */
export function buildSceneFromFloorPlanProposal(
  proposal: FloorPlanSceneProposal,
  candidates: readonly FloorPlanAssetCandidate[],
  floorPlanImagePath: string | null = null,
): BuildFloorPlanSceneResult {
  const doc = createSceneDoc();
  const warnings: string[] = [];

  const widthM = safeMetres(proposal.widthM, DEFAULT_ASSUMED_WIDTH_M);
  const heightM = safeMetres(proposal.heightM, DEFAULT_ASSUMED_WIDTH_M);

  const boundaryIsUsable = isValidFootprintBoundary(proposal.boundary);
  const boundary = boundaryIsUsable ? proposal.boundary : defaultRectangleBoundary(widthM, heightM);
  if (!boundaryIsUsable) {
    warnings.push(
      `The suggested boundary had fewer than ${MIN_FOOTPRINT_POINTS} usable points - started from a plain rectangle instead. Re-trace it under Floor plan if it doesn't match.`,
    );
  }
  const bounds = footprintBounds(boundary);

  doc.environment.footprint = {
    boundary,
    walls: wallsFromBoundary(boundary),
    underlay: floorPlanImagePath
      ? { imagePath: floorPlanImagePath, widthM, heightM, centerX: 0, centerZ: 0, rotationY: 0 }
      : null,
  };
  doc.environment.boothWidth = bounds.width;
  doc.environment.boothDepth = bounds.depth;
  doc.camera = defaultCamera(bounds.depth);

  const versions: VersionLookup = {};

  for (const placement of proposal.placements) {
    const built = createNodeForPlacement(placement, candidates);
    if ('problem' in built) {
      warnings.push(built.problem);
      continue;
    }
    const { node, version } = built;
    if (version) versions[version.id] = { version };

    node.transform.position = { x: placement.x, y: 0, z: placement.z };
    node.transform.rotation = { x: 0, y: (placement.rotationDegrees || 0) * RAD_PER_DEG, z: 0 };

    const footprint = localFootprint(node, versions);
    if (footprint) {
      node.transform.position = clampToBounds(node.transform.position, bounds, footprint.width / 2, footprint.depth / 2);
    }

    const placed = placeClearOfAccepted(node, doc, versions, bounds);
    if (!placed) {
      warnings.push(`Dropped "${node.name}": could not find a clear spot near its suggested position.`);
      continue;
    }
    doc.nodes = [...doc.nodes, placed];
  }

  const overlaps = findOverlappingPairs(doc, versions);
  if (overlaps.length > 0) {
    warnings.push(
      `${overlaps.length} placement${overlaps.length === 1 ? '' : 's'} still overlap after automatic placement - nudge them apart in the studio.`,
    );
  }

  return { doc, warnings };
}
