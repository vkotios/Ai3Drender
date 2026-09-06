import { describe, expect, it } from 'vitest';

import {
  findOverlappingPairs,
  localFootprint,
  overlappingNodeNames,
  worldAABB,
  type VersionLookup,
} from '@/lib/scene/collisions';
import { createAssetNode, createPropNode, createSceneDoc } from '@/lib/scene/defaults';
import type { AssetVersion, SceneDoc, SceneNode } from '@/lib/types';
import { makeFurnitureSpec } from '../fixtures';

/** A version whose dimensions default to a 0.7 × 0.72 × 0.8 m (W×D×H) box. */
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
    acceptedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function docWith(nodes: SceneNode[]): SceneDoc {
  return { ...createSceneDoc(), nodes };
}

function lookup(versions: AssetVersion[]): VersionLookup {
  return Object.fromEntries(versions.map((version) => [version.id, { version }]));
}

describe('localFootprint', () => {
  it("reads an asset node's footprint from its version spec, in metres", () => {
    const version = makeVersion({ spec: makeFurnitureSpec({ dimensions: { widthMm: 700, depthMm: 720, heightMm: 800 } }) });
    const node = createAssetNode(version, 'Chair');
    expect(localFootprint(node, lookup([version]))).toEqual({ width: 0.7, depth: 0.72, height: 0.8 });
  });

  it("reads a prop node's footprint from PROP_DEFINITIONS", () => {
    const node = createPropNode('plinth', 'Plinth');
    expect(localFootprint(node, {})).toEqual({ width: 1.2, height: 0.35, depth: 1.2 });
  });

  it('returns null for an asset node whose version has not loaded yet', () => {
    const version = makeVersion();
    const node = createAssetNode(version, 'Chair');
    expect(localFootprint(node, {})).toBeNull();
  });

  it('returns null for a light node - no physical footprint to collide with', () => {
    const node: SceneNode = {
      id: 'light-1',
      name: 'Key light',
      kind: 'light',
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      visible: true,
      assetVersionId: null,
      propKind: null,
      light: { type: 'key', colorHex: '#ffffff', intensity: 1, distance: 5 },
      materialOverrides: {},
    };
    expect(localFootprint(node, {})).toBeNull();
  });
});

describe('worldAABB', () => {
  it('centres the box in X/Z and grounds it at y=0 before translation', () => {
    const node = createPropNode('side_table', 'Side table'); // size [0.5, 0.5, 0.5]
    const box = worldAABB(node, { width: 0.5, height: 0.5, depth: 0.5 });
    expect(box.min).toEqual({ x: -0.25, y: 0, z: -0.25 });
    expect(box.max).toEqual({ x: 0.25, y: 0.5, z: 0.25 });
  });

  it('applies position, then scale and rotation, to grow the world box', () => {
    const node = createPropNode('side_table', 'Side table');
    node.transform.position = { x: 3, y: 0, z: -1 };
    node.transform.scale = { x: 2, y: 1, z: 2 };
    const box = worldAABB(node, { width: 0.5, height: 0.5, depth: 0.5 });
    expect(box.min.x).toBeCloseTo(3 - 0.5);
    expect(box.max.x).toBeCloseTo(3 + 0.5);
    expect(box.min.z).toBeCloseTo(-1 - 0.5);
    expect(box.max.z).toBeCloseTo(-1 + 0.5);
  });

  it('a 90° yaw swaps which world axis the footprint stretches along', () => {
    const node = createPropNode('rug', 'Rug'); // size [3, 0.02, 2] - wide along X, shallow along Z
    node.transform.rotation.y = Math.PI / 2;
    const box = worldAABB(node, { width: 3, height: 0.02, depth: 2 });
    // Rotated a quarter turn: the 3m run is now along Z, the 2m run along X.
    expect(box.max.x - box.min.x).toBeCloseTo(2);
    expect(box.max.z - box.min.z).toBeCloseTo(3);
  });
});

describe('findOverlappingPairs / overlappingNodeNames', () => {
  it('flags two pieces staged on top of each other', () => {
    const version = makeVersion();
    const a = createAssetNode(version, 'Chair A', { position: { x: 0, y: 0, z: 0 } });
    const b = createAssetNode(version, 'Chair B', { position: { x: 0.1, y: 0, z: 0 } });
    const doc = docWith([a, b]);
    const versions = lookup([version]);

    expect(findOverlappingPairs(doc, versions)).toEqual([[a.id, b.id]]);
    expect(overlappingNodeNames(a, doc, versions)).toEqual(['Chair B']);
    expect(overlappingNodeNames(b, doc, versions)).toEqual(['Chair A']);
  });

  it('clears once the pieces are moved far enough apart', () => {
    const version = makeVersion();
    const a = createAssetNode(version, 'Chair A', { position: { x: 0, y: 0, z: 0 } });
    const b = createAssetNode(version, 'Chair B', { position: { x: 5, y: 0, z: 0 } });
    const doc = docWith([a, b]);
    const versions = lookup([version]);

    expect(findOverlappingPairs(doc, versions)).toEqual([]);
    expect(overlappingNodeNames(a, doc, versions)).toEqual([]);
  });

  it('catches an overlap that only exists once rotation is accounted for', () => {
    // Partition: 2.4m wide (X) but only 0.08m deep (Z), centred at the origin.
    // Plinth: 1.2m square, placed 1.5m away along Z - clear of the partition's
    // *unrotated* 0.08m-deep face (partition reaches only to z=0.04, the
    // plinth starts at z=0.9). In local/unrotated space there is no overlap.
    const partition = createPropNode('partition', 'Partition'); // size [2.4, 2.4, 0.08]
    partition.transform.position = { x: 0, y: 0, z: 0 };

    const plinth = createPropNode('plinth', 'Plinth'); // size [1.2, 0.35, 1.2]
    plinth.transform.position = { x: 0, y: 0, z: 1.5 };

    const versions: VersionLookup = {};
    const unrotatedDoc = docWith([partition, plinth]);
    expect(findOverlappingPairs(unrotatedDoc, versions)).toEqual([]);
    expect(overlappingNodeNames(partition, unrotatedDoc, versions)).toEqual([]);

    // Yaw the partition 90°: its 2.4m run now lies along Z instead of X,
    // reaching to z=1.2 - swinging straight into the plinth at z=0.9..2.1.
    // This overlap only exists once the rotation is actually carried into
    // world space, not just checked against the partition's local axes.
    partition.transform.rotation.y = Math.PI / 2;
    const rotatedDoc = docWith([partition, plinth]);
    expect(findOverlappingPairs(rotatedDoc, versions)).toEqual([[partition.id, plinth.id]]);
    expect(overlappingNodeNames(partition, rotatedDoc, versions)).toEqual(['Plinth']);
  });
});
