import { describe, expect, it } from 'vitest';

import { offlineInterpretSceneCommand } from '@/lib/ai/offline';
import type { VersionLookup } from '@/lib/scene/collisions';
import { createAssetNode, createSceneDoc, IDENTITY_TRANSFORM } from '@/lib/scene/defaults';
import type { AssetVersion, SceneDoc, SceneNode } from '@/lib/types';
import { makeFurnitureSpec, makeMaterial } from '../fixtures';

/**
 * `offlineInterpretSceneCommand` (lib/ai/offline.ts) is the no-API-key
 * fallback for `interpretSceneCommand` (issue #60) - a small deterministic
 * keyword parser for a handful of obvious verbs, exercised here exactly as CI
 * runs it with an empty .env. Every mutation it produces is run back through
 * `normalizeRawMutation`, so this suite is really checking that the right
 * kind of mutation, targeting the right node, comes out the other end.
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

describe('offlineInterpretSceneCommand', () => {
  it("parses the issue's own example: a move plus a light warm-up, in one command", () => {
    const version = makeVersion();
    const doc = docWith([createAssetNode(version, 'Sofa'), lightNode()]);

    const { mutations, unresolved } = offlineInterpretSceneCommand(
      doc,
      lookup([version]),
      'move the sofa 30cm left and warm up the lighting',
    );

    expect(unresolved).toEqual([]);
    const move = mutations.find((m) => m.kind === 'move_node');
    expect(move).toEqual({ kind: 'move_node', nodeName: 'Sofa', deltaMeters: { x: -0.3, y: 0, z: 0 } });

    const light = mutations.find((m) => m.kind === 'set_light_property');
    expect(light).toBeDefined();
    if (light?.kind === 'set_light_property') {
      expect(light.nodeName).toBe('Key Light');
      expect(light.colorHex).not.toBeNull();
      expect(light.colorHex).not.toBe('#FFFFFF');
    }
  });

  it('converts cm and mm to metres and resolves left/right/forward/back/up/down', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Chair')]);
    const cases: Array<[string, { x: number; y: number; z: number }]> = [
      ['move the chair 300mm right', { x: 0.3, y: 0, z: 0 }],
      ['move the chair 1m forward', { x: 0, y: 0, z: 1 }],
      ['move the chair 0.5m back', { x: 0, y: 0, z: -0.5 }],
      ['move the chair 20cm up', { x: 0, y: 0.2, z: 0 }],
      ['move the chair 20cm down', { x: 0, y: -0.2, z: 0 }],
    ];
    for (const [command, deltaMeters] of cases) {
      const { mutations } = offlineInterpretSceneCommand(doc, {}, command);
      expect(mutations).toEqual([{ kind: 'move_node', nodeName: 'Chair', deltaMeters }]);
    }
  });

  it('hides and shows a named node', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Chair')]);
    expect(offlineInterpretSceneCommand(doc, {}, 'hide the chair').mutations).toEqual([
      { kind: 'set_visibility', nodeName: 'Chair', visible: false },
    ]);
    // Start from hidden so "show" is a real, reportable change.
    const hiddenDoc = docWith([{ ...createAssetNode(makeVersion(), 'Chair'), visible: false }]);
    expect(offlineInterpretSceneCommand(hiddenDoc, {}, 'show the chair').mutations).toEqual([
      { kind: 'set_visibility', nodeName: 'Chair', visible: true },
    ]);
  });

  it('rotates a named node by degrees, defaulting to a positive (left) turn', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Chair')]);
    expect(offlineInterpretSceneCommand(doc, {}, 'rotate the chair 45 degrees').mutations).toEqual([
      { kind: 'rotate_node', nodeName: 'Chair', deltaDegrees: { x: 0, y: 45, z: 0 } },
    ]);
    expect(offlineInterpretSceneCommand(doc, {}, 'turn the chair 45 degrees clockwise').mutations).toEqual([
      { kind: 'rotate_node', nodeName: 'Chair', deltaDegrees: { x: 0, y: -45, z: 0 } },
    ]);
  });

  it('scales a named node from a percentage, a fixed keyword, or half/double', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Chair')]);
    expect(offlineInterpretSceneCommand(doc, {}, 'make the chair 20% bigger').mutations).toEqual([
      { kind: 'scale_node', nodeName: 'Chair', scaleFactor: 1.2 },
    ]);
    expect(offlineInterpretSceneCommand(doc, {}, 'make the chair smaller').mutations).toEqual([
      { kind: 'scale_node', nodeName: 'Chair', scaleFactor: 0.8 },
    ]);
    expect(offlineInterpretSceneCommand(doc, {}, 'scale the chair to half size').mutations).toEqual([
      { kind: 'scale_node', nodeName: 'Chair', scaleFactor: 0.5 },
    ]);
  });

  it('adds a recognised prop kind, including a two-word name', () => {
    const doc = docWith([]);
    expect(offlineInterpretSceneCommand(doc, {}, 'add a rug').mutations).toEqual([
      { kind: 'add_prop', propKind: 'rug', name: null },
    ]);
    expect(offlineInterpretSceneCommand(doc, {}, 'add a floor lamp').mutations).toEqual([
      { kind: 'add_prop', propKind: 'floor_lamp', name: null },
    ]);
  });

  it('applies "warm up"/"cool down" to every light when none is named, and to just one when named', () => {
    const doc = docWith([lightNode({ id: 'l1', name: 'Key Light' }), lightNode({ id: 'l2', name: 'Fill Light' })]);

    const both = offlineInterpretSceneCommand(doc, {}, 'warm up the lighting');
    expect(both.mutations).toHaveLength(2);
    expect(both.mutations.every((m) => m.kind === 'set_light_property')).toBe(true);

    const one = offlineInterpretSceneCommand(doc, {}, 'cool down the key light');
    expect(one.mutations).toHaveLength(1);
    expect(one.mutations[0]).toMatchObject({ nodeName: 'Key Light' });
  });

  it('is deterministic: the same (light, command) pair always produces the same colour shift', () => {
    const doc = docWith([lightNode()]);
    const a = offlineInterpretSceneCommand(doc, {}, 'warm up the key light');
    const b = offlineInterpretSceneCommand(doc, {}, 'warm up the key light');
    expect(a).toEqual(b);
  });

  it('darkens a material on an asset with a single material, offline and deterministically', () => {
    const version = makeVersion();
    const doc = docWith([createAssetNode(version, 'Chair')]);
    const a = offlineInterpretSceneCommand(doc, lookup([version]), 'make the chair darker');
    expect(a.unresolved).toEqual([]);
    expect(a.mutations).toHaveLength(1);
    const mutation = a.mutations[0];
    expect(mutation.kind).toBe('set_material_override');
    if (mutation.kind === 'set_material_override') {
      expect(mutation.nodeName).toBe('Chair');
      expect(mutation.baseColorHex).not.toBeNull();
      expect(mutation.baseColorHex).not.toBe(version.spec.materials[0].baseColorHex);
    }

    const b = offlineInterpretSceneCommand(doc, lookup([version]), 'make the chair darker');
    expect(a).toEqual(b);
  });

  it('disambiguates a named material on a multi-material asset', () => {
    const version = makeVersion({
      spec: makeFurnitureSpec({
        materials: [makeMaterial({ id: 'frame', name: 'Frame' }), makeMaterial({ id: 'cushion', name: 'Cushion' })],
      }),
    });
    const doc = docWith([createAssetNode(version, 'Sofa')]);
    const { mutations } = offlineInterpretSceneCommand(doc, lookup([version]), 'make the cushion matte');
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0];
    expect(mutation.kind).toBe('set_material_override');
    if (mutation.kind === 'set_material_override') {
      expect(mutation.materialName).toBe('Cushion');
      expect(mutation.finish).toBe('matte');
    }
  });

  it('reports a clause it cannot parse in "unresolved" rather than silently dropping it', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Chair')]);
    const { mutations, unresolved } = offlineInterpretSceneCommand(doc, {}, 'juggle the chair enthusiastically');
    expect(mutations).toEqual([]);
    expect(unresolved).toEqual(['juggle the chair enthusiastically']);
  });

  it('adds a light, defaulting to key when no type is named and picking the named type otherwise', () => {
    const doc = docWith([]);
    expect(offlineInterpretSceneCommand(doc, {}, 'add a light').mutations).toEqual([
      { kind: 'add_light', lightType: 'key', name: null },
    ]);
    expect(offlineInterpretSceneCommand(doc, {}, 'add a fill light').mutations).toEqual([
      { kind: 'add_light', lightType: 'fill', name: null },
    ]);
  });

  it('deletes and duplicates a named node', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Chair')]);
    expect(offlineInterpretSceneCommand(doc, {}, 'delete the chair').mutations).toEqual([
      { kind: 'delete_node', nodeName: 'Chair' },
    ]);
    expect(offlineInterpretSceneCommand(doc, {}, 'duplicate the chair').mutations).toEqual([
      { kind: 'duplicate_node', nodeName: 'Chair' },
    ]);
  });

  it('splits a multi-part command on "and"/commas and resolves each clause independently', () => {
    const doc = docWith([createAssetNode(makeVersion(), 'Chair'), createAssetNode(makeVersion({ id: 'v2' }), 'Table')]);
    const { mutations, unresolved } = offlineInterpretSceneCommand(
      doc,
      {},
      'hide the chair, show the table and do a little dance',
    );
    expect(mutations).toEqual([
      { kind: 'set_visibility', nodeName: 'Chair', visible: false },
      { kind: 'set_visibility', nodeName: 'Table', visible: true },
    ]);
    expect(unresolved).toEqual(['do a little dance']);
  });
});
