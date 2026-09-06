/**
 * Applying a natural-language studio command (issue #60) to a `SceneDoc`.
 *
 * This is deliberately NOT an open-ended agentic tool-use loop - see the issue
 * for why. It follows the same shape every other Gemini-backed "free text in,
 * small structured object out" call in this codebase already uses
 * (`correctMaterial`, `resolvePartReference` in lib/ai/gemini.ts): one call
 * returns an ordered list of mutations drawn from a CLOSED, explicit set (see
 * `SCENE_MUTATION_KINDS` below), which this module then applies
 * deterministically to an in-memory `SceneDoc`.
 *
 * Nothing here calls Gemini. `interpretSceneCommand` in lib/ai/gemini.ts is
 * what produces a `RawSceneMutation[]` from free text (with
 * `offlineInterpretSceneCommand` in lib/ai/offline.ts as the no-API-key
 * fallback); `normalizeRawMutation` here is what both of those call to turn
 * one raw, loosely-typed mutation into either a validated `SceneMutation` or a
 * plain-language reason it was rejected, so the validation rules live in
 * exactly one place regardless of which path produced the raw mutation.
 * `applySceneMutations` is what the API route calls to actually mutate the
 * doc and build the human-readable confirmation summary.
 */
import type { VersionLookup } from './collisions';
import { localFootprint } from './collisions';
import { createPropNode, nextPlacement } from './defaults';
import { PROP_DEFINITIONS } from './presets';
import type { PropKind, SceneDoc, SceneLight, SceneNode, Vec3 } from '@/lib/types';

/** The closed set of edits a command can produce. Never extend this ad hoc from a prompt - add a kind here first. */
export const SCENE_MUTATION_KINDS = [
  'move_node',
  'rotate_node',
  'scale_node',
  'set_material_override',
  'set_light_property',
  'set_visibility',
  'add_prop',
] as const;
export type SceneMutationKind = (typeof SCENE_MUTATION_KINDS)[number];

/**
 * One mutation exactly as the model (Gemini or the offline parser) emits it -
 * a flat shape carrying every field any kind might use, almost all of them
 * optional. Gemini's structured-output schema (see `SCENE_COMMAND_SCHEMA` in
 * lib/ai/schemas.ts) has no good way to express "this field only applies when
 * `kind` is X" as a discriminated union, so the wire shape stays flat and
 * `normalizeRawMutation` is what actually enforces which fields matter for
 * which kind.
 */
export interface RawSceneMutation {
  kind: string;
  /** Exact `SceneNode.name`, copied verbatim from the node list the model was shown. Null/absent when this mutation names no existing node (add_prop), or none plausibly matched. */
  nodeName?: string | null;
  deltaMeters?: Partial<Vec3> | null;
  deltaDegrees?: Partial<Vec3> | null;
  scaleFactor?: number | null;
  materialName?: string | null;
  baseColorHex?: string | null;
  roughness?: number | null;
  metalness?: number | null;
  finish?: string | null;
  colorHex?: string | null;
  intensity?: number | null;
  distance?: number | null;
  visible?: boolean | null;
  propKind?: string | null;
  name?: string | null;
}

/** A mutation that has been validated and resolved against a real `SceneDoc` - safe for `applySceneMutations` to apply blindly. */
export type SceneMutation =
  | { kind: 'move_node'; nodeName: string; deltaMeters: Vec3 }
  | { kind: 'rotate_node'; nodeName: string; deltaDegrees: Vec3 }
  | { kind: 'scale_node'; nodeName: string; scaleFactor: number }
  | {
      kind: 'set_material_override';
      nodeName: string;
      materialName: string | null;
      baseColorHex: string | null;
      roughness: number | null;
      metalness: number | null;
      finish: string | null;
    }
  | {
      kind: 'set_light_property';
      nodeName: string;
      colorHex: string | null;
      intensity: number | null;
      distance: number | null;
    }
  | { kind: 'set_visibility'; nodeName: string; visible: boolean }
  | { kind: 'add_prop'; propKind: PropKind; name: string | null };

export interface SceneCommandResult {
  mutations: SceneMutation[];
  /** Plain-language reasons a clause of the command could not become a mutation - shown to the operator alongside the summary. */
  unresolved: string[];
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

function hex(value: unknown): string | null {
  return typeof value === 'string' && HEX_RE.test(value.trim()) ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function vec3(value: Partial<Vec3> | null | undefined): Vec3 {
  return { x: num(value?.x) ?? 0, y: num(value?.y) ?? 0, z: num(value?.z) ?? 0 };
}

function clamp(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = num(value);
  return Math.min(hi, Math.max(lo, n ?? fallback));
}

const PROP_KINDS = Object.keys(PROP_DEFINITIONS) as PropKind[];

/** Case-insensitive exact match against a node's display name. Never guesses at a close-but-not-equal name. */
export function resolveNodeByName(nodeName: string | null | undefined, doc: SceneDoc): SceneNode | null {
  if (!nodeName) return null;
  const target = nodeName.trim().toLowerCase();
  return doc.nodes.find((n) => n.name.trim().toLowerCase() === target) ?? null;
}

/**
 * The material override key and current effective PBR values (an existing
 * override where set, the underlying spec/prop default otherwise) for one
 * node - shared by `applySceneMutations` (to know which `materialOverrides`
 * key to write) and the offline command parser (to compute a "darker"/
 * "lighter" delta from the colour actually showing right now).
 *
 * `materialName` disambiguates when an asset has more than one material; null
 * resolves only when the asset has exactly one (nothing to disambiguate) or
 * the node is a prop (which always has the single `"prop"` slot).
 */
export function resolveMaterialTarget(
  node: SceneNode,
  materialName: string | null,
  versions: VersionLookup,
): { key: string; current: { baseColorHex: string; roughness: number; metalness: number; finish: string } } | null {
  if (node.kind === 'prop') {
    if (!node.propKind) return null;
    const definition = PROP_DEFINITIONS[node.propKind];
    const override = node.materialOverrides.prop ?? {};
    return {
      key: 'prop',
      current: {
        baseColorHex: override.baseColorHex ?? definition.colorHex,
        roughness: override.roughness ?? definition.roughness,
        metalness: override.metalness ?? 0,
        finish: override.finish ?? '',
      },
    };
  }
  if (node.kind !== 'asset' || !node.assetVersionId) return null;
  const materials = versions[node.assetVersionId]?.version.spec.materials ?? [];
  const specMaterial = materialName
    ? materials.find((m) => m.name.trim().toLowerCase() === materialName.trim().toLowerCase())
    : materials.length === 1
      ? materials[0]
      : undefined;
  if (!specMaterial) return null;
  const override = node.materialOverrides[specMaterial.id] ?? {};
  return {
    key: specMaterial.id,
    current: {
      baseColorHex: override.baseColorHex ?? specMaterial.baseColorHex,
      roughness: override.roughness ?? specMaterial.roughness,
      metalness: override.metalness ?? specMaterial.metalness,
      finish: override.finish ?? specMaterial.finish,
    },
  };
}

/**
 * Validate and resolve one raw mutation against a real `SceneDoc`. Returns
 * either the validated mutation or `{ problem }`, a plain-language reason
 * suitable for showing the operator directly - never throws, so one bad
 * mutation in a batch never sinks the rest of the command.
 */
export function normalizeRawMutation(
  raw: RawSceneMutation,
  doc: SceneDoc,
): SceneMutation | { problem: string } {
  const kind = raw.kind as SceneMutationKind;
  if (!(SCENE_MUTATION_KINDS as readonly string[]).includes(kind)) {
    return { problem: `"${raw.kind}" is not a supported kind of edit - skipped.` };
  }

  if (kind === 'add_prop') {
    const propKind = PROP_KINDS.find((k) => k === raw.propKind);
    if (!propKind) {
      return { problem: `"${raw.propKind ?? 'that prop'}" is not a supported prop kind - skipped.` };
    }
    return { kind, propKind, name: raw.name?.trim() || null };
  }

  const node = resolveNodeByName(raw.nodeName, doc);
  if (!node) {
    return {
      problem: raw.nodeName
        ? `Could not find a piece named "${raw.nodeName}" on the stage - skipped.`
        : `Could not tell which piece a "${kind.replace(/_/g, ' ')}" instruction refers to - skipped.`,
    };
  }

  switch (kind) {
    case 'move_node': {
      const deltaMeters = vec3(raw.deltaMeters);
      if (deltaMeters.x === 0 && deltaMeters.y === 0 && deltaMeters.z === 0) {
        return { problem: `A move instruction for "${node.name}" had no usable distance - skipped.` };
      }
      return { kind, nodeName: node.name, deltaMeters };
    }

    case 'rotate_node': {
      const deltaDegrees = vec3(raw.deltaDegrees);
      if (deltaDegrees.x === 0 && deltaDegrees.y === 0 && deltaDegrees.z === 0) {
        return { problem: `A rotate instruction for "${node.name}" had no usable angle - skipped.` };
      }
      return { kind, nodeName: node.name, deltaDegrees };
    }

    case 'scale_node': {
      const factor = num(raw.scaleFactor);
      if (factor === null || factor <= 0) {
        return { problem: `A resize instruction for "${node.name}" had no usable multiplier - skipped.` };
      }
      return { kind, nodeName: node.name, scaleFactor: clamp(factor, 0.05, 20, 1) };
    }

    case 'set_material_override': {
      if (node.kind !== 'asset' && node.kind !== 'prop') {
        return { problem: `"${node.name}" has no material to change - skipped.` };
      }
      const baseColorHex = hex(raw.baseColorHex);
      const roughness = raw.roughness == null ? null : clamp(raw.roughness, 0, 1, 0);
      const metalness = raw.metalness == null ? null : clamp(raw.metalness, 0, 1, 0);
      const finish = raw.finish?.trim() || null;
      if (baseColorHex === null && roughness === null && metalness === null && finish === null) {
        return { problem: `A material instruction for "${node.name}" had no usable colour/finish change - skipped.` };
      }
      return { kind, nodeName: node.name, materialName: raw.materialName?.trim() || null, baseColorHex, roughness, metalness, finish };
    }

    case 'set_light_property': {
      if (node.kind !== 'light' || !node.light) {
        return { problem: `"${node.name}" is not a light - skipped.` };
      }
      const colorHex = hex(raw.colorHex);
      const intensity = raw.intensity == null ? null : clamp(raw.intensity, 0, 50, node.light.intensity);
      const distance = raw.distance == null ? null : clamp(raw.distance, 0, 50, node.light.distance);
      if (colorHex === null && intensity === null && distance === null) {
        return { problem: `A light instruction for "${node.name}" had no usable change - skipped.` };
      }
      return { kind, nodeName: node.name, colorHex, intensity, distance };
    }

    case 'set_visibility': {
      if (typeof raw.visible !== 'boolean') {
        return { problem: `A visibility instruction for "${node.name}" didn't say show or hide - skipped.` };
      }
      return { kind, nodeName: node.name, visible: raw.visible };
    }

    default:
      return { problem: `"${raw.kind}" is not a supported kind of edit - skipped.` };
  }
}

export interface ApplyMutationsResult {
  doc: SceneDoc;
  /** One line per mutation actually applied, in order applied - the operator-facing confirmation. */
  changes: string[];
  /** One line per mutation that resolved but could not actually be applied (stale reference, nothing left to change). */
  problems: string[];
}

const RAD_PER_DEG = Math.PI / 180;

function formatMetreDelta(d: Vec3): string {
  const parts: string[] = [];
  if (Math.abs(d.x) > 1e-6) parts.push(`${Math.abs(d.x).toFixed(2)}m ${d.x < 0 ? '-X (left)' : '+X (right)'}`);
  if (Math.abs(d.y) > 1e-6) parts.push(`${Math.abs(d.y).toFixed(2)}m ${d.y < 0 ? '-Y (down)' : '+Y (up)'}`);
  if (Math.abs(d.z) > 1e-6) parts.push(`${Math.abs(d.z).toFixed(2)}m ${d.z < 0 ? '-Z (back)' : '+Z (front)'}`);
  return parts.join(', ');
}

function formatDegreeDelta(d: Vec3): string {
  const parts: string[] = [];
  if (Math.abs(d.x) > 1e-6) parts.push(`${Math.abs(d.x).toFixed(0)}° about X`);
  if (Math.abs(d.y) > 1e-6) parts.push(`${Math.abs(d.y).toFixed(0)}° about Y`);
  if (Math.abs(d.z) > 1e-6) parts.push(`${Math.abs(d.z).toFixed(0)}° about Z`);
  return parts.join(', ');
}

function describePatch(patch: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  if (patch.baseColorHex) parts.push(String(patch.baseColorHex).toUpperCase());
  if (patch.colorHex) parts.push(String(patch.colorHex).toUpperCase());
  if (patch.roughness !== undefined) parts.push(`roughness ${Number(patch.roughness).toFixed(2)}`);
  if (patch.metalness !== undefined) parts.push(`metalness ${Number(patch.metalness).toFixed(2)}`);
  if (patch.finish) parts.push(String(patch.finish));
  if (patch.intensity !== undefined) parts.push(`intensity ${Number(patch.intensity).toFixed(2)}`);
  if (patch.distance !== undefined) parts.push(`distance ${Number(patch.distance).toFixed(1)}m`);
  return parts.join(', ');
}

/**
 * Apply an ordered list of already-validated mutations to a `SceneDoc`,
 * building the operator-facing confirmation as it goes. Pure and
 * synchronous - no store access, no Gemini call - so it is trivially unit
 * testable and reusable from both the API route and tests.
 *
 * Each mutation is re-resolved against the working copy of `nodes` (not the
 * original `doc`), so a batch that both adds a prop and then, say, hides it
 * by the name it was just given works in one command.
 */
export function applySceneMutations(
  doc: SceneDoc,
  mutations: SceneMutation[],
  versions: VersionLookup,
): ApplyMutationsResult {
  let nodes = doc.nodes;
  const changes: string[] = [];
  const problems: string[] = [];

  for (const mutation of mutations) {
    if (mutation.kind === 'add_prop') {
      const definition = PROP_DEFINITIONS[mutation.propKind];
      const name = mutation.name ?? definition.label;
      const node = createPropNode(mutation.propKind, name);
      const placement = nextPlacement(
        { ...doc, nodes },
        (n) => localFootprint(n, versions)?.width ?? 1,
        definition.size[0],
      );
      node.transform = { ...node.transform, position: placement };
      nodes = [...nodes, node];
      changes.push(`Added a ${name}.`);
      continue;
    }

    const node = nodes.find((n) => n.name === mutation.nodeName);
    if (!node) {
      problems.push(`"${mutation.nodeName}" is no longer on the stage - skipped.`);
      continue;
    }

    switch (mutation.kind) {
      case 'move_node': {
        const { x, y, z } = mutation.deltaMeters;
        const position = {
          x: node.transform.position.x + x,
          y: node.transform.position.y + y,
          z: node.transform.position.z + z,
        };
        nodes = nodes.map((n) => (n.id === node.id ? { ...n, transform: { ...n.transform, position } } : n));
        changes.push(`Moved ${node.name} ${formatMetreDelta(mutation.deltaMeters)}.`);
        break;
      }

      case 'rotate_node': {
        const rotation = {
          x: node.transform.rotation.x + mutation.deltaDegrees.x * RAD_PER_DEG,
          y: node.transform.rotation.y + mutation.deltaDegrees.y * RAD_PER_DEG,
          z: node.transform.rotation.z + mutation.deltaDegrees.z * RAD_PER_DEG,
        };
        nodes = nodes.map((n) => (n.id === node.id ? { ...n, transform: { ...n.transform, rotation } } : n));
        changes.push(`Rotated ${node.name} ${formatDegreeDelta(mutation.deltaDegrees)}.`);
        break;
      }

      case 'scale_node': {
        const factor = mutation.scaleFactor;
        const scale = {
          x: node.transform.scale.x * factor,
          y: node.transform.scale.y * factor,
          z: node.transform.scale.z * factor,
        };
        nodes = nodes.map((n) => (n.id === node.id ? { ...n, transform: { ...n.transform, scale } } : n));
        changes.push(`Scaled ${node.name} by ${factor.toFixed(2)}x.`);
        break;
      }

      case 'set_material_override': {
        const target = resolveMaterialTarget(node, mutation.materialName, versions);
        if (!target) {
          problems.push(
            `Could not find ${mutation.materialName ? `a material named "${mutation.materialName}"` : 'an unambiguous material'} on "${node.name}" - skipped.`,
          );
          break;
        }
        const patch: Record<string, string | number> = {};
        if (mutation.baseColorHex) patch.baseColorHex = mutation.baseColorHex;
        if (mutation.roughness !== null) patch.roughness = mutation.roughness;
        if (mutation.metalness !== null) patch.metalness = mutation.metalness;
        if (mutation.finish) patch.finish = mutation.finish;
        nodes = nodes.map((n) =>
          n.id === node.id
            ? { ...n, materialOverrides: { ...n.materialOverrides, [target.key]: { ...n.materialOverrides[target.key], ...patch } } }
            : n,
        );
        changes.push(`Set ${node.name}'s material to ${describePatch(patch)}.`);
        break;
      }

      case 'set_light_property': {
        if (!node.light) {
          problems.push(`"${node.name}" is not a light - skipped.`);
          break;
        }
        const patch: Record<string, string | number> = {};
        if (mutation.colorHex) patch.colorHex = mutation.colorHex;
        if (mutation.intensity !== null) patch.intensity = mutation.intensity;
        if (mutation.distance !== null) patch.distance = mutation.distance;
        const light: SceneLight = { ...node.light, ...patch };
        nodes = nodes.map((n) => (n.id === node.id ? { ...n, light } : n));
        changes.push(`Set ${node.name} to ${describePatch(patch)}.`);
        break;
      }

      case 'set_visibility': {
        nodes = nodes.map((n) => (n.id === node.id ? { ...n, visible: mutation.visible } : n));
        changes.push(`${mutation.visible ? 'Showed' : 'Hid'} ${node.name}.`);
        break;
      }
    }
  }

  return { doc: { ...doc, nodes }, changes, problems };
}

/**
 * Compact, plain-language description of every staged node - what the model
 * (or the offline parser, for its own node-matching) is shown of the current
 * `SceneDoc`, so it can resolve "the sofa" and describe deltas against real
 * current values rather than guessing blind.
 *
 * Coordinate convention (also documented directly in the Gemini prompt, see
 * `interpretSceneCommand`): +X is to the right and -X is to the left, as seen
 * from the aisle camera facing the booth - the same convention
 * `describeAnchor` in lib/scene/anchor.ts already uses. +Z is toward the
 * aisle/camera (the front) and -Z is toward the back wall. +Y is up.
 */
export function summarizeSceneForCommand(doc: SceneDoc, versions: VersionLookup): string {
  if (doc.nodes.length === 0) return '(nothing is staged yet)';
  const deg = 180 / Math.PI;

  return doc.nodes
    .map((node) => {
      const t = node.transform;
      const pos = `position (${t.position.x.toFixed(2)}, ${t.position.y.toFixed(2)}, ${t.position.z.toFixed(2)})m`;
      const rot = `rotation (${(t.rotation.x * deg).toFixed(0)}, ${(t.rotation.y * deg).toFixed(0)}, ${(t.rotation.z * deg).toFixed(0)})°`;
      const scale = `scale (${t.scale.x.toFixed(2)}, ${t.scale.y.toFixed(2)}, ${t.scale.z.toFixed(2)})`;
      const visibility = node.visible ? 'visible' : 'hidden';

      if (node.kind === 'light' && node.light) {
        return `- "${node.name}" (light, ${node.light.type}): colour ${node.light.colorHex}, intensity ${node.light.intensity}, distance ${node.light.distance}m, ${visibility}`;
      }
      if (node.kind === 'prop' && node.propKind) {
        return `- "${node.name}" (prop, ${node.propKind}): ${pos}, ${rot}, ${scale}, ${visibility}`;
      }
      const materials = node.assetVersionId ? (versions[node.assetVersionId]?.version.spec.materials ?? []) : [];
      const materialNames = materials.length > 0 ? materials.map((m) => m.name).join(', ') : 'unknown';
      return `- "${node.name}" (asset): ${pos}, ${rot}, ${scale}, ${visibility}, materials: ${materialNames}`;
    })
    .join('\n');
}
