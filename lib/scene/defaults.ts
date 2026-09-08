import type {
  AssetVersion,
  CameraSettings,
  PropKind,
  SceneDoc,
  SceneLight,
  SceneNode,
  Transform,
  Vec3,
} from '@/lib/types';

import { DEFAULT_PRESET_ID, getPreset, LIGHT_DEFAULTS } from './presets';

export const IDENTITY_TRANSFORM: Transform = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

/**
 * A camera framing the booth from the aisle, at standing eye height. 40 degrees
 * vertical is close to a 35mm lens, which is what interiors are usually shot on
 * - wider starts to distort the furniture at the frame edges.
 */
export function defaultCamera(boothDepth: number): CameraSettings {
  return {
    position: { x: 3.2, y: 1.65, z: boothDepth / 2 + 3.5 },
    target: { x: 0, y: 0.6, z: 0 },
    fov: 40,
  };
}

export function createSceneDoc(presetId: string = DEFAULT_PRESET_ID): SceneDoc {
  const preset = getPreset(presetId);
  return {
    schemaVersion: 1,
    environment: { presetId: preset.id, ...preset.environment },
    camera: defaultCamera(preset.environment.boothDepth),
    nodes: [],
  };
}

// Web Crypto, so this module works unchanged in the browser (the studio adds
// nodes client-side) and on the server. Available in Node 19+ and all target
// browsers in a secure context.
const newId = () => globalThis.crypto.randomUUID();

export function createAssetNode(version: AssetVersion, name: string, at?: Partial<Transform>): SceneNode {
  return {
    id: newId(),
    name,
    kind: 'asset',
    transform: { ...IDENTITY_TRANSFORM, ...at },
    visible: true,
    assetVersionId: version.id,
    propKind: null,
    light: null,
    materialOverrides: {},
  };
}

export function createPropNode(propKind: PropKind, name: string): SceneNode {
  return {
    id: newId(),
    name,
    kind: 'prop',
    transform: structuredClone(IDENTITY_TRANSFORM),
    visible: true,
    assetVersionId: null,
    propKind,
    light: null,
    materialOverrides: {},
  };
}

/** A new light node (issue #92), seeded from `LIGHT_DEFAULTS` for its type. */
export function createLightNode(type: SceneLight['type'], name: string): SceneNode {
  const defaults = LIGHT_DEFAULTS[type];
  return {
    id: newId(),
    name,
    kind: 'light',
    transform: { ...IDENTITY_TRANSFORM, position: { ...defaults.position } },
    visible: true,
    assetVersionId: null,
    propKind: null,
    light: { type, colorHex: defaults.colorHex, intensity: defaults.intensity, distance: defaults.distance },
    materialOverrides: {},
  };
}

/** Metres of clear floor left between staged pieces. */
const AISLE_GAP = 0.9;

/**
 * Where to drop a newly staged piece.
 *
 * Everything defaults to the origin, so without this each piece lands inside
 * the last one. Placing to the right of the current row is the behaviour a
 * layout tool is expected to have.
 */
export function nextPlacement(
  doc: SceneDoc,
  footprintOf: (node: SceneNode) => number,
  newWidth: number,
): Vec3 {
  const staged = doc.nodes.filter((n) => n.kind === 'asset');
  if (staged.length === 0) return { x: 0, y: 0, z: 0 };

  const rightEdge = staged.reduce(
    (max, node) => Math.max(max, node.transform.position.x + footprintOf(node) / 2),
    -Infinity,
  );

  const x = rightEdge + AISLE_GAP + newWidth / 2;
  const limit = doc.environment.boothWidth / 2 - newWidth / 2;
  // Past the edge of the stand, start a second row further back instead of
  // pushing pieces through the wall.
  if (x > limit) {
    return { x: -limit, y: 0, z: Math.min(doc.environment.boothDepth / 2 - 1, 2) };
  }
  return { x, y: 0, z: 0 };
}

/**
 * Re-flow every staged piece into one centred row, sized by real footprints.
 * Used by the "Arrange" action when a layout has been pushed around.
 */
export function autoArrange(
  nodes: SceneNode[],
  footprints: Map<string, number>,
  boothWidth: number,
): SceneNode[] {
  const placeable = nodes.filter((n) => n.kind === 'asset');
  const totalWidth = placeable.reduce(
    (sum, n) => sum + (footprints.get(n.id) ?? 1) + AISLE_GAP,
    -AISLE_GAP,
  );

  let cursor = -totalWidth / 2;
  return nodes.map((node) => {
    if (node.kind !== 'asset') return node;
    const width = footprints.get(node.id) ?? 1;
    const x = cursor + width / 2;
    cursor += width + AISLE_GAP;
    const limit = boothWidth / 2 - width / 2;
    return {
      ...node,
      transform: {
        ...node.transform,
        position: {
          ...node.transform.position,
          x: Math.max(-limit, Math.min(limit, x)),
          z: 0,
        },
      },
    };
  });
}
