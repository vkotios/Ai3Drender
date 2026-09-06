import { describe, expect, it } from 'vitest';

import { findOverlappingPairs, localFootprint, type VersionLookup } from '@/lib/scene/collisions';
import {
  DEFAULT_ASSUMED_WIDTH_M,
  buildSceneFromFloorPlanProposal,
  resolveScaleM,
  type FloorPlanAssetCandidate,
} from '@/lib/scene/floorplan-scene';
import { isValidFootprintBoundary } from '@/lib/scene/footprint';
import type { AssetVersion, FloorPlanSceneProposal, FurnitureAsset } from '@/lib/types';
import { makeFurnitureSpec } from '../fixtures';

/** A version whose dimensions default to a 0.7 x 0.72 x 0.8 m (W x D x H) box - same fixture shape as tests/scene/collisions.test.ts. */
function makeVersion(overrides: Partial<AssetVersion> = {}): AssetVersion {
  return {
    id: 'v1',
    assetId: 'asset-1',
    versionNumber: 1,
    label: 'v1',
    parentVersionId: null,
    spec: makeFurnitureSpec(),
    views: [],
    meshPath: 'mesh.glb',
    meshExtentMm: null,
    previewPath: null,
    provider: 'stub',
    providerJobId: null,
    refinement: null,
    qaResult: null,
    previewMeshPath: null,
    acceptedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAsset(overrides: Partial<FurnitureAsset> = {}): FurnitureAsset {
  return {
    id: 'asset-1',
    projectId: 'project-1',
    name: 'Sofa',
    status: 'ready',
    currentVersionId: 'v1',
    sourceImageIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function candidate(overrides: Partial<FurnitureAsset> = {}, versionOverrides: Partial<AssetVersion> = {}): FloorPlanAssetCandidate {
  const version = makeVersion(versionOverrides);
  return { asset: makeAsset({ currentVersionId: version.id, ...overrides }), version };
}

function makeProposal(overrides: Partial<FloorPlanSceneProposal> = {}): FloorPlanSceneProposal {
  return {
    boundary: [
      { x: -4, z: -3 },
      { x: 4, z: -3 },
      { x: 4, z: 3 },
      { x: -4, z: 3 },
    ],
    widthM: 8,
    heightM: 6,
    placements: [],
    ...overrides,
  };
}

describe('resolveScaleM', () => {
  it('uses the model\'s width guess when it is a plausible positive number', () => {
    expect(resolveScaleM(10, 1000, 500)).toEqual({ widthM: 10, heightM: 5 });
  });

  it('falls back to the default assumed width when there is no guess', () => {
    expect(resolveScaleM(null, 1000, 1000)).toEqual({ widthM: DEFAULT_ASSUMED_WIDTH_M, heightM: DEFAULT_ASSUMED_WIDTH_M });
    expect(resolveScaleM(undefined, 1000, 1000).widthM).toBe(DEFAULT_ASSUMED_WIDTH_M);
  });

  it('falls back to the default for a non-positive or non-finite guess', () => {
    expect(resolveScaleM(0, 1000, 1000).widthM).toBe(DEFAULT_ASSUMED_WIDTH_M);
    expect(resolveScaleM(-5, 1000, 1000).widthM).toBe(DEFAULT_ASSUMED_WIDTH_M);
    expect(resolveScaleM(NaN, 1000, 1000).widthM).toBe(DEFAULT_ASSUMED_WIDTH_M);
  });

  it('clamps an implausible guess into a sane range', () => {
    expect(resolveScaleM(1000, 1000, 1000).widthM).toBeLessThanOrEqual(40);
    expect(resolveScaleM(0.001, 1000, 1000).widthM).toBeGreaterThanOrEqual(1);
  });

  it('derives height from the image aspect ratio, matching a manual underlay upload\'s own math', () => {
    const { widthM, heightM } = resolveScaleM(8, 1600, 1200);
    expect(widthM).toBe(8);
    expect(heightM).toBeCloseTo(8 * (1200 / 1600));
  });
});

describe('buildSceneFromFloorPlanProposal', () => {
  it('populates environment.footprint exactly as a manual trace would: boundary, one closed wall per edge, booth size synced to its bounds', () => {
    const proposal = makeProposal();
    const { doc, warnings } = buildSceneFromFloorPlanProposal(proposal, []);

    expect(warnings).toEqual([]);
    expect(doc.environment.footprint?.boundary).toEqual(proposal.boundary);
    expect(doc.environment.footprint?.walls).toHaveLength(proposal.boundary.length);
    expect(doc.environment.footprint?.walls.every((w) => !w.open)).toBe(true);
    expect(doc.environment.boothWidth).toBeCloseTo(8);
    expect(doc.environment.boothDepth).toBeCloseTo(6);
  });

  it('sets the underlay from the given image path, at the booth origin with no rotation', () => {
    const { doc } = buildSceneFromFloorPlanProposal(makeProposal(), [], 'proj-1/floorplans/plan.png');
    expect(doc.environment.footprint?.underlay).toEqual({
      imagePath: 'proj-1/floorplans/plan.png',
      widthM: 8,
      heightM: 6,
      centerX: 0,
      centerZ: 0,
      rotationY: 0,
    });
  });

  it('leaves the underlay null when no image path is given', () => {
    const { doc } = buildSceneFromFloorPlanProposal(makeProposal(), []);
    expect(doc.environment.footprint?.underlay).toBeNull();
  });

  it('falls back to a plain rectangle, with a warning, when the suggested boundary is not usable', () => {
    const proposal = makeProposal({ boundary: [{ x: 0, z: 0 }, { x: 1, z: 0 }], widthM: 10, heightM: 5 });
    const { doc, warnings } = buildSceneFromFloorPlanProposal(proposal, []);

    expect(isValidFootprintBoundary(doc.environment.footprint?.boundary)).toBe(true);
    expect(doc.environment.boothWidth).toBeCloseTo(10);
    expect(doc.environment.boothDepth).toBeCloseTo(5);
    expect(warnings.some((w) => /fewer than/i.test(w))).toBe(true);
  });

  it('resolves a placement to a real asset node by exact (case-insensitive) name match', () => {
    const sofa = candidate({ name: 'Oslo Sofa' });
    const proposal = makeProposal({
      placements: [{ assetName: 'oslo sofa', propKind: null, name: null, x: 1, z: 0, rotationDegrees: 90 }],
    });

    const { doc, warnings } = buildSceneFromFloorPlanProposal(proposal, [sofa]);

    expect(warnings).toEqual([]);
    expect(doc.nodes).toHaveLength(1);
    const [node] = doc.nodes;
    expect(node.kind).toBe('asset');
    expect(node.assetVersionId).toBe(sofa.version.id);
    expect(node.name).toBe('Oslo Sofa');
    expect(node.transform.position).toEqual({ x: 1, y: 0, z: 0 });
    expect(node.transform.rotation.y).toBeCloseTo(Math.PI / 2);
  });

  it('falls back to a generic prop when no asset name matches', () => {
    const proposal = makeProposal({
      placements: [{ assetName: null, propKind: 'rug', name: 'Entry rug', x: 0, z: 1, rotationDegrees: 0 }],
    });

    const { doc, warnings } = buildSceneFromFloorPlanProposal(proposal, []);

    expect(warnings).toEqual([]);
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]).toMatchObject({ kind: 'prop', propKind: 'rug', name: 'Entry rug' });
  });

  it('drops a placement matching neither a known asset nor a valid prop kind, with a warning', () => {
    const proposal = makeProposal({
      placements: [{ assetName: 'Nonexistent Chair', propKind: null, name: null, x: 0, z: 0, rotationDegrees: 0 }],
    });

    const { doc, warnings } = buildSceneFromFloorPlanProposal(proposal, []);

    expect(doc.nodes).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Nonexistent Chair/);
  });

  it('nudges a second placement clear when it would otherwise land on top of the first', () => {
    const proposal = makeProposal({
      placements: [
        { assetName: null, propKind: 'plinth', name: 'A', x: 0, z: 0, rotationDegrees: 0 }, // 1.2m square
        { assetName: null, propKind: 'plinth', name: 'B', x: 0.1, z: 0, rotationDegrees: 0 }, // nearly on top of A
      ],
    });

    const { doc, warnings } = buildSceneFromFloorPlanProposal(proposal, []);

    expect(doc.nodes).toHaveLength(2);
    const versions: VersionLookup = {};
    expect(findOverlappingPairs(doc, versions)).toEqual([]);
    // Nudging is silent (only a residual, un-resolvable overlap warns).
    expect(warnings).toEqual([]);
  });

  it('drops a placement (with a warning) rather than shipping an overlap when nothing clears it', () => {
    // A boundary far too small to fit two 1.2m plinths apart at all.
    const proposal = makeProposal({
      boundary: [
        { x: -0.65, z: -0.65 },
        { x: 0.65, z: -0.65 },
        { x: 0.65, z: 0.65 },
        { x: -0.65, z: 0.65 },
      ],
      widthM: 1.3,
      heightM: 1.3,
      placements: [
        { assetName: null, propKind: 'plinth', name: 'A', x: 0, z: 0, rotationDegrees: 0 },
        { assetName: null, propKind: 'plinth', name: 'B', x: 0, z: 0, rotationDegrees: 0 },
      ],
    });

    const { doc, warnings } = buildSceneFromFloorPlanProposal(proposal, []);

    expect(doc.nodes).toHaveLength(1);
    expect(warnings.some((w) => /Dropped "B"/.test(w))).toBe(true);
    const versions: VersionLookup = {};
    expect(findOverlappingPairs(doc, versions)).toEqual([]);
  });

  it('clamps a placement fully inside the boundary\'s bounding box, given its own footprint', () => {
    const proposal = makeProposal({
      // Suggested well outside the 8x6 boundary.
      placements: [{ assetName: null, propKind: 'plinth', name: 'Corner plinth', x: 100, z: -100, rotationDegrees: 0 }],
    });

    const { doc } = buildSceneFromFloorPlanProposal(proposal, []);
    const [node] = doc.nodes;
    const footprint = localFootprint(node, {});
    expect(footprint).not.toBeNull();
    expect(node.transform.position.x).toBeLessThanOrEqual(4 - footprint!.width / 2 + 1e-9);
    expect(node.transform.position.z).toBeGreaterThanOrEqual(-3 + footprint!.depth / 2 - 1e-9);
  });
});
