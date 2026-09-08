import { describe, expect, it } from 'vitest';

import {
  applySceneMutations,
  normalizeRawMutation,
  resolveMaterialTarget,
  resolveNodeByName,
  summarizeSceneForCommand,
  type RawSceneMutation,
} from '@/lib/scene/command';
import { createAssetNode, createPropNode, createSceneDoc, IDENTITY_TRANSFORM } from '@/lib/scene/defaults';
import type { VersionLookup } from '@/lib/scene/collisions';
import type { AssetVersion, SceneDoc, SceneNode } from '@/lib/types';
import { makeFurnitureSpec, makeMaterial } from '../fixtures';

/**
 * Issue #60: natural-language studio commands are turned into a small, closed
 * set of `SceneMutation`s (never an open-ended agentic tool-use loop) and
 * applied deterministically here. `normalizeRawMutation`/`applySceneMutations`
 * are exercised directly against plain `RawSceneMutation` objects - the same
 * shape both `interpretSceneCommand` (Gemini) and `offlineInterpretSceneCommand`
 * produce - so this suite never has to mock a model.
 */

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

function lightNode(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id: 'light-1',
    name: 'Key Light',
    kind: 'light',
    transform: structuredClone(IDENTITY_TRANSFORM),
    visible: true,
    assetVersionId: null,
    propKind: null,
    light: { type: 'key', colorHex: '#FFFFFF', intensity: 1, distance: 5 },
    materialOverrides: {},
    ...overrides,
  };
}

function docWith(nodes: SceneNode[]): SceneDoc {
  return { ...createSceneDoc(), nodes };
}

function lookup(versions: AssetVersion[]): VersionLookup {
  return Object.fromEntries(versions.map((v) => [v.id, { version: v }]));
}

describe('resolveNodeByName', () => {
  it('matches a node name case-insensitively', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    expect(resolveNodeByName('sofa', doc)?.name).toBe('Sofa');
    expect(resolveNodeByName('SOFA', doc)?.name).toBe('Sofa');
  });

  it('returns null for no name and for no match', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    expect(resolveNodeByName(null, doc)).toBeNull();
    expect(resolveNodeByName('Armchair', doc)).toBeNull();
  });
});

describe('resolveMaterialTarget', () => {
  it("resolves a prop node to the single 'prop' override key", () => {
    const node = createPropNode('rug', 'Rug');
    const target = resolveMaterialTarget(node, null, {});
    expect(target?.key).toBe('prop');
    expect(target?.current.baseColorHex).toBe('#9C9382'); // PROP_DEFINITIONS['rug'].colorHex
  });

  it('resolves an asset node with exactly one material when no name is given', () => {
    const version = makeVersion();
    const node = createAssetNode(version, 'Chair');
    const target = resolveMaterialTarget(node, null, lookup([version]));
    expect(target?.key).toBe(version.spec.materials[0].id);
    expect(target?.current.baseColorHex).toBe(version.spec.materials[0].baseColorHex);
  });

  it('returns null for an ambiguous asset (multiple materials, no name given)', () => {
    const version = makeVersion({
      spec: makeFurnitureSpec({
        materials: [makeMaterial({ id: 'frame', name: 'Frame' }), makeMaterial({ id: 'cushion', name: 'Cushion' })],
      }),
    });
    const node = createAssetNode(version, 'Sofa');
    expect(resolveMaterialTarget(node, null, lookup([version]))).toBeNull();
  });

  it('resolves a named material on a multi-material asset, case-insensitively', () => {
    const version = makeVersion({
      spec: makeFurnitureSpec({
        materials: [makeMaterial({ id: 'frame', name: 'Frame' }), makeMaterial({ id: 'cushion', name: 'Cushion' })],
      }),
    });
    const node = createAssetNode(version, 'Sofa');
    const target = resolveMaterialTarget(node, 'cushion', lookup([version]));
    expect(target?.key).toBe('cushion');
  });

  it('reads an existing override in preference to the spec default', () => {
    const version = makeVersion();
    let node = createAssetNode(version, 'Chair');
    node = { ...node, materialOverrides: { [version.spec.materials[0].id]: { baseColorHex: '#111111' } } };
    const target = resolveMaterialTarget(node, null, lookup([version]));
    expect(target?.current.baseColorHex).toBe('#111111');
  });
});

describe('normalizeRawMutation', () => {
  it('rejects an unsupported kind', () => {
    const doc = docWith([]);
    const result = normalizeRawMutation({ kind: 'launch_node' } as RawSceneMutation, doc);
    expect(result).toHaveProperty('problem');
  });

  it('rejects a mutation that names no piece on the stage', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    const result = normalizeRawMutation(
      { kind: 'move_node', nodeName: 'Armchair', deltaMeters: { x: 1, y: 0, z: 0 } },
      doc,
    );
    expect(result).toEqual({ problem: expect.stringMatching(/could not find.*armchair/i) });
  });

  it('rejects a move/rotate with no net delta', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    expect(normalizeRawMutation({ kind: 'move_node', nodeName: 'Sofa', deltaMeters: { x: 0, y: 0, z: 0 } }, doc)).toHaveProperty('problem');
    expect(normalizeRawMutation({ kind: 'rotate_node', nodeName: 'Sofa', deltaDegrees: null }, doc)).toHaveProperty('problem');
  });

  it('accepts a valid move_node and clamps nothing it does not need to', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    const result = normalizeRawMutation(
      { kind: 'move_node', nodeName: 'sofa', deltaMeters: { x: -0.3, y: 0, z: 0 } },
      doc,
    );
    expect(result).toEqual({ kind: 'move_node', nodeName: 'Sofa', deltaMeters: { x: -0.3, y: 0, z: 0 } });
  });

  it('clamps an out-of-range scale factor', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    const result = normalizeRawMutation({ kind: 'scale_node', nodeName: 'Sofa', scaleFactor: 999 }, doc);
    expect(result).toEqual({ kind: 'scale_node', nodeName: 'Sofa', scaleFactor: 20 });
  });

  it('rejects a scale_node with a non-positive multiplier', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    expect(normalizeRawMutation({ kind: 'scale_node', nodeName: 'Sofa', scaleFactor: 0 }, doc)).toHaveProperty('problem');
    expect(normalizeRawMutation({ kind: 'scale_node', nodeName: 'Sofa', scaleFactor: -2 }, doc)).toHaveProperty('problem');
  });

  it('rejects set_visibility without an explicit boolean', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    expect(normalizeRawMutation({ kind: 'set_visibility', nodeName: 'Sofa' }, doc)).toHaveProperty('problem');
  });

  it('rejects set_light_property targeting a non-light node', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    const result = normalizeRawMutation({ kind: 'set_light_property', nodeName: 'Sofa', colorHex: '#ffaa00' }, doc);
    expect(result).toEqual({ problem: expect.stringMatching(/not a light/i) });
  });

  it('rejects set_material_override targeting a light node', () => {
    const doc = docWith([lightNode()]);
    const result = normalizeRawMutation(
      { kind: 'set_material_override', nodeName: 'Key Light', baseColorHex: '#ffaa00' },
      doc,
    );
    expect(result).toEqual({ problem: expect.stringMatching(/no material/i) });
  });

  it('rejects an add_prop with an unsupported prop kind', () => {
    const result = normalizeRawMutation({ kind: 'add_prop', propKind: 'chandelier' }, docWith([]));
    expect(result).toHaveProperty('problem');
  });

  it('accepts a valid add_prop and defaults name to null', () => {
    const result = normalizeRawMutation({ kind: 'add_prop', propKind: 'rug' }, docWith([]));
    expect(result).toEqual({ kind: 'add_prop', propKind: 'rug', name: null });
  });

  it('rejects an invalid hex colour rather than passing it through', () => {
    const doc = docWith([lightNode()]);
    const result = normalizeRawMutation(
      { kind: 'set_light_property', nodeName: 'Key Light', colorHex: 'not-a-colour', intensity: 2 },
      doc,
    );
    expect(result).toEqual({ kind: 'set_light_property', nodeName: 'Key Light', colorHex: null, intensity: 2, distance: null });
  });

  it('rejects an add_light with an unsupported light type', () => {
    const result = normalizeRawMutation({ kind: 'add_light', lightType: 'spot' }, docWith([]));
    expect(result).toHaveProperty('problem');
  });

  it('accepts a valid add_light and defaults name to null', () => {
    const result = normalizeRawMutation({ kind: 'add_light', lightType: 'fill' }, docWith([]));
    expect(result).toEqual({ kind: 'add_light', lightType: 'fill', name: null });
  });

  it('accepts delete_node and duplicate_node targeting an existing node', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa')]);
    expect(normalizeRawMutation({ kind: 'delete_node', nodeName: 'sofa' }, doc)).toEqual({
      kind: 'delete_node',
      nodeName: 'Sofa',
    });
    expect(normalizeRawMutation({ kind: 'duplicate_node', nodeName: 'sofa' }, doc)).toEqual({
      kind: 'duplicate_node',
      nodeName: 'Sofa',
    });
  });

  it('rejects delete_node/duplicate_node naming no piece on the stage', () => {
    const doc = docWith([]);
    expect(normalizeRawMutation({ kind: 'delete_node', nodeName: 'Ghost' }, doc)).toHaveProperty('problem');
    expect(normalizeRawMutation({ kind: 'duplicate_node', nodeName: 'Ghost' }, doc)).toHaveProperty('problem');
  });
});

describe('applySceneMutations', () => {
  it('moves a node by the given delta and reports it in the summary', () => {
    const node = createAssetNode(makeVersion(), 'Sofa', { position: { x: 1, y: 0, z: 0 } });
    const doc = docWith([node]);
    const result = applySceneMutations(
      doc,
      [{ kind: 'move_node', nodeName: 'Sofa', deltaMeters: { x: -0.3, y: 0, z: 0 } }],
      {},
    );
    expect(result.doc.nodes[0].transform.position).toEqual({ x: 0.7, y: 0, z: 0 });
    expect(result.changes).toEqual(['Moved Sofa 0.30m -X (left).']);
    expect(result.problems).toEqual([]);
  });

  it('rotates a node, converting degrees to radians and accumulating onto the existing rotation', () => {
    const node = createAssetNode(makeVersion(), 'Sofa');
    const doc = docWith([node]);
    const result = applySceneMutations(
      doc,
      [{ kind: 'rotate_node', nodeName: 'Sofa', deltaDegrees: { x: 0, y: 90, z: 0 } }],
      {},
    );
    expect(result.doc.nodes[0].transform.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(result.changes[0]).toMatch(/Rotated Sofa 90° about Y/);
  });

  it('scales a node multiplicatively, not absolutely', () => {
    const node = { ...createAssetNode(makeVersion(), 'Sofa'), transform: { ...IDENTITY_TRANSFORM, scale: { x: 2, y: 2, z: 2 } } };
    const doc = docWith([node]);
    const result = applySceneMutations(doc, [{ kind: 'scale_node', nodeName: 'Sofa', scaleFactor: 1.5 }], {});
    expect(result.doc.nodes[0].transform.scale).toEqual({ x: 3, y: 3, z: 3 });
  });

  it('shows and hides a node', () => {
    const node = createAssetNode(makeVersion(), 'Sofa');
    const doc = docWith([{ ...node, visible: true }]);
    const hidden = applySceneMutations(doc, [{ kind: 'set_visibility', nodeName: 'Sofa', visible: false }], {});
    expect(hidden.doc.nodes[0].visible).toBe(false);
    expect(hidden.changes).toEqual(['Hid Sofa.']);
  });

  it('writes a material override keyed by the resolved material id, merging onto any existing override', () => {
    const version = makeVersion();
    const node = {
      ...createAssetNode(version, 'Chair'),
      materialOverrides: { [version.spec.materials[0].id]: { metalness: 0.2 } },
    };
    const doc = docWith([node]);
    const result = applySceneMutations(
      doc,
      [
        {
          kind: 'set_material_override',
          nodeName: 'Chair',
          materialName: null,
          baseColorHex: '#222222',
          roughness: 0.6,
          metalness: null,
          finish: null,
        },
      ],
      lookup([version]),
    );
    const override = result.doc.nodes[0].materialOverrides[version.spec.materials[0].id];
    expect(override).toEqual({ metalness: 0.2, baseColorHex: '#222222', roughness: 0.6 });
    expect(result.changes[0]).toMatch(/Set Chair's material to #222222, roughness 0.60/);
  });

  it('reports a problem instead of applying when the material cannot be resolved', () => {
    const version = makeVersion({
      spec: makeFurnitureSpec({
        materials: [makeMaterial({ id: 'a', name: 'A' }), makeMaterial({ id: 'b', name: 'B' })],
      }),
    });
    const node = createAssetNode(version, 'Chair');
    const doc = docWith([node]);
    const result = applySceneMutations(
      doc,
      [
        {
          kind: 'set_material_override',
          nodeName: 'Chair',
          materialName: 'nonexistent',
          baseColorHex: '#222222',
          roughness: null,
          metalness: null,
          finish: null,
        },
      ],
      lookup([version]),
    );
    expect(result.changes).toEqual([]);
    expect(result.problems).toEqual([expect.stringMatching(/could not find a material named "nonexistent"/i)]);
    // Nothing was written.
    expect(result.doc.nodes[0].materialOverrides).toEqual({});
  });

  it('sets a light property, merging onto the existing SceneLight', () => {
    const doc = docWith([lightNode()]);
    const result = applySceneMutations(
      doc,
      [{ kind: 'set_light_property', nodeName: 'Key Light', colorHex: '#FFD9A0', intensity: 1.4, distance: null }],
      {},
    );
    expect(result.doc.nodes[0].light).toEqual({ type: 'key', colorHex: '#FFD9A0', intensity: 1.4, distance: 5 });
    expect(result.changes).toEqual(["Set Key Light to #FFD9A0, intensity 1.40."]);
  });

  it('adds a prop, placing it via the same nextPlacement layout logic manual staging uses', () => {
    const doc = docWith([]);
    const result = applySceneMutations(doc, [{ kind: 'add_prop', propKind: 'rug', name: null }], {});
    expect(result.doc.nodes).toHaveLength(1);
    expect(result.doc.nodes[0]).toMatchObject({ kind: 'prop', propKind: 'rug', name: 'Rug' });
    expect(result.changes).toEqual(['Added a Rug.']);
  });

  it('applies mutations in order, so a later one can act on a node an earlier one just added', () => {
    const doc = docWith([]);
    const result = applySceneMutations(
      doc,
      [
        { kind: 'add_prop', propKind: 'rug', name: 'Runner' },
        { kind: 'set_visibility', nodeName: 'Runner', visible: false },
      ],
      {},
    );
    expect(result.doc.nodes[0].visible).toBe(false);
    expect(result.changes).toEqual(['Added a Runner.', 'Hid Runner.']);
  });

  it('reports (rather than throws on) a mutation whose node has since disappeared from the working set', () => {
    const doc = docWith([]);
    const result = applySceneMutations(doc, [{ kind: 'move_node', nodeName: 'Ghost', deltaMeters: { x: 1, y: 0, z: 0 } }], {});
    expect(result.changes).toEqual([]);
    expect(result.problems).toEqual(['"Ghost" is no longer on the stage - skipped.']);
  });

  it('adds a light, seeded from that light type\'s defaults', () => {
    const doc = docWith([]);
    const result = applySceneMutations(doc, [{ kind: 'add_light', lightType: 'fill', name: null }], {});
    expect(result.doc.nodes).toHaveLength(1);
    expect(result.doc.nodes[0]).toMatchObject({ kind: 'light', name: 'Fill light' });
    expect(result.doc.nodes[0].light).toMatchObject({ type: 'fill' });
    expect(result.changes).toEqual(['Added a Fill light.']);
  });

  it('deletes a node', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Sofa'), createPropNode('rug', 'Rug')]);
    const result = applySceneMutations(doc, [{ kind: 'delete_node', nodeName: 'Sofa' }], {});
    expect(result.doc.nodes).toHaveLength(1);
    expect(result.doc.nodes[0].name).toBe('Rug');
    expect(result.changes).toEqual(['Deleted Sofa.']);
  });

  it('duplicates a node, offsetting the copy so it does not land inside the original', () => {
    const node = createAssetNode(makeVersion(), 'Sofa', { position: { x: 1, y: 0, z: 2 } });
    const doc = docWith([node]);
    const result = applySceneMutations(doc, [{ kind: 'duplicate_node', nodeName: 'Sofa' }], {});
    expect(result.doc.nodes).toHaveLength(2);
    const copy = result.doc.nodes[1];
    expect(copy.id).not.toBe(node.id);
    expect(copy.name).toBe('Sofa copy');
    expect(copy.transform.position).toEqual({ x: 1.3, y: 0, z: 2.3 });
    expect(result.changes).toEqual(['Duplicated Sofa.']);
  });
});

describe('summarizeSceneForCommand', () => {
  it('describes an empty stage', () => {
    expect(summarizeSceneForCommand(docWith([]), {})).toMatch(/nothing is staged/i);
  });

  it("lists each node's kind, transform and (for an asset) its materials", () => {
    const version = makeVersion();
    const doc = docWith([createAssetNode(version, 'Chair'), lightNode(), createPropNode('rug', 'Rug')]);
    const summary = summarizeSceneForCommand(doc, lookup([version]));
    expect(summary).toContain('"Chair" (asset)');
    expect(summary).toContain(version.spec.materials[0].name);
    expect(summary).toContain('"Key Light" (light, key)');
    expect(summary).toContain('"Rug" (prop, rug)');
  });
});
