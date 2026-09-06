import type { VersionLookup } from '@/lib/scene/collisions';
import {
  normalizeRawMutation,
  resolveMaterialTarget,
  type RawSceneMutation,
  type SceneCommandResult,
} from '@/lib/scene/command';
import { resolveScaleM } from '@/lib/scene/floorplan-scene';
import type {
  FloorPlanSceneProposal,
  FurnitureSpec,
  MaterialLibraryEntry,
  MaterialSpec,
  QaResult,
  SceneDirection,
  SceneDoc,
  SceneNode,
} from '@/lib/types';

/**
 * Deterministic stand-in for the Gemini vision pass, used when GEMINI_API_KEY
 * is unset. It cannot see the photos, so it infers a category from filenames
 * and fills in trade-standard dimensions for that category.
 *
 * Everything it produces is marked `dimensionConfidence: 'rough'` and says so
 * in the summary - the point is to keep the pipeline runnable, never to pass
 * guesses off as measurements.
 */

interface CategoryProfile {
  keywords: string[];
  category: string;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  seatHeightMm: number | null;
  components: { name: string; role: string; materialId: string; fraction: [number, number, number] }[];
}

const PROFILES: CategoryProfile[] = [
  {
    keywords: ['sofa', 'couch', 'settee', 'loveseat'],
    category: 'sofa',
    widthMm: 2100,
    depthMm: 900,
    heightMm: 800,
    seatHeightMm: 430,
    components: [
      { name: 'Seat cushions', role: 'seat', materialId: 'upholstery', fraction: [0.95, 0.7, 0.18] },
      { name: 'Backrest', role: 'backrest', materialId: 'upholstery', fraction: [0.95, 0.25, 0.5] },
      { name: 'Arms', role: 'armrest', materialId: 'upholstery', fraction: [0.12, 0.9, 0.35] },
      { name: 'Legs', role: 'leg', materialId: 'frame', fraction: [0.06, 0.06, 0.18] },
    ],
  },
  {
    keywords: ['chair', 'armchair', 'lounge', 'seat'],
    category: 'lounge chair',
    widthMm: 700,
    depthMm: 720,
    heightMm: 800,
    seatHeightMm: 440,
    components: [
      { name: 'Seat', role: 'seat', materialId: 'upholstery', fraction: [0.9, 0.8, 0.14] },
      { name: 'Backrest', role: 'backrest', materialId: 'upholstery', fraction: [0.9, 0.14, 0.45] },
      { name: 'Legs', role: 'leg', materialId: 'frame', fraction: [0.07, 0.07, 0.55] },
    ],
  },
  {
    keywords: ['stool', 'bench', 'ottoman', 'pouf'],
    category: 'stool',
    widthMm: 450,
    depthMm: 450,
    heightMm: 650,
    seatHeightMm: 650,
    components: [
      { name: 'Seat', role: 'seat', materialId: 'upholstery', fraction: [1, 1, 0.12] },
      { name: 'Legs', role: 'leg', materialId: 'frame', fraction: [0.08, 0.08, 0.88] },
    ],
  },
  {
    keywords: ['table', 'dining', 'desk', 'console'],
    category: 'dining table',
    widthMm: 2000,
    depthMm: 950,
    heightMm: 750,
    seatHeightMm: null,
    components: [
      { name: 'Top', role: 'top', materialId: 'frame', fraction: [1, 1, 0.06] },
      { name: 'Legs', role: 'leg', materialId: 'frame', fraction: [0.06, 0.06, 0.94] },
    ],
  },
  {
    keywords: ['cabinet', 'sideboard', 'credenza', 'dresser', 'shelf', 'bookcase'],
    category: 'sideboard',
    widthMm: 1800,
    depthMm: 450,
    heightMm: 800,
    seatHeightMm: null,
    components: [
      { name: 'Carcass', role: 'frame', materialId: 'frame', fraction: [1, 1, 0.85] },
      { name: 'Doors', role: 'panel', materialId: 'frame', fraction: [0.48, 0.04, 0.8] },
      { name: 'Plinth', role: 'leg', materialId: 'accent', fraction: [0.95, 0.9, 0.12] },
    ],
  },
  {
    keywords: ['bed', 'headboard'],
    category: 'bed',
    widthMm: 1800,
    depthMm: 2100,
    heightMm: 1100,
    seatHeightMm: 550,
    components: [
      { name: 'Headboard', role: 'backrest', materialId: 'upholstery', fraction: [1, 0.08, 0.55] },
      { name: 'Base', role: 'frame', materialId: 'upholstery', fraction: [1, 1, 0.3] },
    ],
  },
];

const FALLBACK = PROFILES[1];

/** Stable 32-bit hash, used only to make the offline output deterministic. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickProfile(filenames: string[]): CategoryProfile {
  const haystack = filenames.join(' ').toLowerCase();
  return PROFILES.find((p) => p.keywords.some((k) => haystack.includes(k))) ?? FALLBACK;
}

const WOOD_TONES = ['#6B4A2F', '#8B5A2B', '#A9764B', '#4A3423', '#C2A17A'];
const TEXTILE_TONES = ['#8C8778', '#5C6670', '#9C6B58', '#3F4A45', '#B9AE9B'];

/**
 * Deterministically "match" a synthetic default material against the library
 * candidates whose kind it could plausibly be, exactly like the vision pass
 * does but without a model to make the judgement call. Picking the
 * lowest-id candidate (rather than, say, the newest) keeps the choice stable
 * across runs given the same library, which is what makes this path testable
 * without a live model.
 */
function matchCandidate(
  candidates: MaterialLibraryEntry[],
  kinds: MaterialSpec['kind'][],
): MaterialLibraryEntry | null {
  const eligible = candidates
    .filter((c) => !c.archivedAt && kinds.includes(c.kind))
    .sort((a, b) => a.id.localeCompare(b.id));
  return eligible[0] ?? null;
}

/** Build one material entry, bound to `candidate` when one was found. */
function toMaterial(
  id: string,
  fallback: Omit<MaterialSpec, 'id' | 'libraryEntryId' | 'invented'>,
  candidate: MaterialLibraryEntry | null,
): MaterialSpec {
  if (!candidate) return { id, ...fallback, libraryEntryId: null, invented: true };
  return {
    id,
    name: candidate.name,
    kind: candidate.kind,
    baseColorHex: candidate.baseColorHex,
    roughness: candidate.roughness,
    metalness: candidate.metalness,
    sheen: candidate.sheen,
    clearcoat: candidate.clearcoat,
    finish: candidate.finish,
    notes: 'Matched against the material library (offline analyzer).',
    libraryEntryId: candidate.id,
    invented: false,
  };
}

function materialsFor(
  profile: CategoryProfile,
  seed: number,
  libraryCandidates: MaterialLibraryEntry[],
): MaterialSpec[] {
  const wood = WOOD_TONES[seed % WOOD_TONES.length];
  const textile = TEXTILE_TONES[(seed >>> 3) % TEXTILE_TONES.length];
  const upholstered = profile.components.some((c) => c.materialId === 'upholstery');

  const materials: MaterialSpec[] = [
    toMaterial(
      'frame',
      {
        name: 'Solid timber frame',
        kind: 'wood',
        baseColorHex: wood,
        roughness: 0.55,
        metalness: 0,
        sheen: 0,
        clearcoat: 0.25,
        finish: 'oiled',
        notes: 'Offline default. Replace once a vision pass has run on the photos.',
      },
      matchCandidate(libraryCandidates, ['wood']),
    ),
    toMaterial(
      'accent',
      {
        name: 'Blackened steel accent',
        kind: 'metal',
        baseColorHex: '#2A2A2D',
        roughness: 0.42,
        metalness: 1,
        sheen: 0,
        clearcoat: 0,
        finish: 'powder-coated',
        notes: 'Offline default.',
      },
      matchCandidate(libraryCandidates, ['metal']),
    ),
  ];

  if (upholstered) {
    materials.unshift(
      toMaterial(
        'upholstery',
        {
          name: 'Wool-blend upholstery',
          kind: 'fabric',
          baseColorHex: textile,
          roughness: 0.92,
          metalness: 0,
          sheen: 0.55,
          clearcoat: 0,
          finish: 'woven',
          notes: 'Offline default.',
        },
        matchCandidate(libraryCandidates, ['fabric', 'leather']),
      ),
    );
  }
  return materials;
}

export function offlineFurnitureSpec(
  filenames: string[],
  brief?: string | null,
  /**
   * The account's known materials. When one matches a synthetic slot's kind,
   * that slot is bound to it (its PBR fields are the library's, not the
   * synthetic default) instead of being flagged invented. Mirrors what the
   * live vision pass does with library candidates, deterministically.
   */
  libraryCandidates: MaterialLibraryEntry[] = [],
): FurnitureSpec {
  const seed = hash(filenames.join('|') || 'ai3drender');
  const profile = pickProfile(filenames);
  const materials = materialsFor(profile, seed, libraryCandidates);

  return {
    displayName: profile.category.replace(/\b\w/g, (c) => c.toUpperCase()),
    category: profile.category,
    summary:
      `Offline placeholder spec for a ${profile.category}. No vision model was configured, ` +
      'so dimensions come from category conventions rather than from the photographs. ' +
      'Set GEMINI_API_KEY and re-run analysis before using these figures.',
    dimensions: {
      widthMm: profile.widthMm,
      depthMm: profile.depthMm,
      heightMm: profile.heightMm,
    },
    seatHeightMm: profile.seatHeightMm,
    dimensionConfidence: 'rough',
    components: profile.components.map((c) => ({
      name: c.name,
      role: c.role,
      materialId: materials.some((m) => m.id === c.materialId) ? c.materialId : materials[0].id,
      approxSizeMm: {
        widthMm: Math.round(profile.widthMm * c.fraction[0]),
        depthMm: Math.round(profile.depthMm * c.fraction[1]),
        heightMm: Math.round(profile.heightMm * c.fraction[2]),
      },
    })),
    materials,
    palette: materials.map((m) => m.baseColorHex),
    styleTags: ['contemporary', 'trade-show ready', brief ? 'briefed' : 'unbriefed'],
    symmetry: 'bilateral',
    reconstructionNotes:
      'Preserve the silhouette and leg taper. Do not merge separate cushions into one volume. ' +
      'Keep any gap between backrest and seat open rather than filling it.',
  };
}

/**
 * Deterministic stand-in for the perceptual QA vision pass. There is no model
 * to actually compare the mesh against the photos, so this does not fabricate
 * a real fidelity judgement - `score`/`defects` are placeholders, never shown
 * as if they were a real check. `source: 'offline'` is what callers (the
 * pipeline, the UI badge) must key off of: it is what marks this as "not
 * actually assessed" rather than "assessed and found perfect". Consistent
 * with `offlineFurnitureSpec` producing a clearly-labelled placeholder rather
 * than throwing, so the pipeline keeps running end to end without a key.
 *
 * `defects: []` rather than a fabricated category (issue #56) - there is no
 * vision pass here to have found anything, categorized or not.
 */
export function offlineQaResult(): QaResult {
  return {
    score: 100,
    defects: [],
    source: 'offline',
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * Blend a hex colour toward black (delta < 0) or white (delta > 0) by
 * `abs(delta)`. An invalid hex falls back to mid-grey first, same guard
 * `normalizeSpec` in lib/ai/gemini.ts uses.
 */
function mixHex(hex: string, delta: number): string {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#9a9a9a';
  const n = clean.replace('#', '');
  const target = delta < 0 ? 0 : 255;
  const t = Math.min(1, Math.abs(delta));
  const mixed = [0, 2, 4].map((i) => {
    const channel = parseInt(n.slice(i, i + 2), 16);
    return Math.round(channel + (target - channel) * t);
  });
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export type MaterialCorrectionFields = Pick<
  MaterialSpec,
  'baseColorHex' | 'roughness' | 'metalness' | 'sheen' | 'clearcoat' | 'finish' | 'notes'
>;

/**
 * Deterministic stand-in for a Gemini-driven material spot-fix, used when
 * GEMINI_API_KEY is unset. It cannot regenerate texture without a model, so
 * instead it reads a handful of plain-language cues out of the instruction
 * (darker/lighter, matte/glossy, rough/smooth, metallic) and nudges the PBR
 * values accordingly - never a no-op, so the endpoint stays fully
 * exercisable with zero API keys.
 *
 * The size of each nudge (`magnitude`) is seeded off the material id plus the
 * instruction text via the same FNV hash `offlineFurnitureSpec` uses, so a
 * given (material, instruction) pair always produces the same result -
 * mirroring that function's determinism - while different instructions still
 * land differently rather than every correction applying the same fixed step.
 */
export function offlineMaterialCorrection(
  material: Pick<MaterialSpec, 'id' | 'baseColorHex' | 'roughness' | 'metalness' | 'sheen' | 'clearcoat' | 'finish'>,
  instruction: string,
): MaterialCorrectionFields {
  const words = ` ${instruction.toLowerCase()} `;
  const has = (...keywords: string[]) => keywords.some((k) => words.includes(k));
  const seed = hash(`${material.id}|${instruction}`);
  const magnitude = 0.12 + (seed % 17) / 100; // 0.12..0.28

  let baseColorHex = material.baseColorHex;
  let roughness = material.roughness;
  let metalness = material.metalness;
  let clearcoat = material.clearcoat;
  let finish = material.finish;
  let matched = false;

  if (has('dark', 'darker', 'deep', 'espresso', 'ebony', 'charcoal')) {
    baseColorHex = mixHex(baseColorHex, -magnitude);
    matched = true;
  } else if (has('light', 'lighter', 'pale', 'bleached', 'blonde')) {
    baseColorHex = mixHex(baseColorHex, magnitude);
    matched = true;
  }

  if (has('matte', 'matt', 'flat finish')) {
    roughness = clamp01(roughness + magnitude);
    clearcoat = clamp01(clearcoat - magnitude);
    finish = 'matte';
    matched = true;
  } else if (has('glossy', 'gloss', 'shiny', 'polished', 'lacquered')) {
    roughness = clamp01(roughness - magnitude);
    clearcoat = clamp01(clearcoat + magnitude);
    finish = 'polished';
    matched = true;
  } else if (has('rough', 'coarse', 'textured')) {
    roughness = clamp01(roughness + magnitude);
    matched = true;
  } else if (has('smooth', 'sleek', 'silky')) {
    roughness = clamp01(roughness - magnitude);
    matched = true;
  }

  if (has('metallic', 'chrome', 'brushed metal')) {
    metalness = clamp01(metalness + magnitude);
    matched = true;
  }

  if (!matched) {
    // No recognised cue in the instruction: a live Gemini call would still
    // return *some* change, so nudge colour and roughness by the same seeded
    // magnitude rather than silently leaving the material untouched.
    const sign = seed % 2 === 0 ? -1 : 1;
    baseColorHex = mixHex(baseColorHex, sign * magnitude);
    roughness = clamp01(roughness + sign * magnitude * 0.5);
  }

  return {
    baseColorHex,
    roughness,
    metalness,
    sheen: material.sheen,
    clearcoat,
    finish,
    notes: `Spot-fixed offline per instruction: "${instruction.trim()}" (deterministic adjustment, no vision model configured).`,
  };
}

/**
 * Deterministic stand-in for Gemini-driven free-text part matching, used when
 * GEMINI_API_KEY is unset (see `resolvePartReference` in lib/ai/gemini.ts,
 * issue #57). It cannot reason about the request the way a model can, so
 * instead it scores each candidate part by how many words it shares with the
 * query - checking both the part's name and its role, since "the legs" only
 * literally shares a word with a part named "Legs", but "the frame" should
 * still resolve a part whose name is unrelated but whose role is "frame".
 * Returns the single highest-scoring part, or null when nothing shares even
 * one word, rather than guessing at a part the query gave no basis for.
 */
export function offlineResolvePartReference(
  query: string,
  parts: { name: string; role: string }[],
): string | null {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const queryWords = words(query);
  if (queryWords.size === 0) return null;

  let best: { name: string; score: number } | null = null;
  for (const part of parts) {
    const score = [...words(`${part.name} ${part.role}`)].filter((w) => queryWords.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { name: part.name, score };
  }
  return best?.name ?? null;
}

export function offlineSceneDirection(pieces: string[]): SceneDirection {
  return {
    concept: 'Neutral gallery booth',
    rationale:
      `A restrained warm-grey booth keeps attention on ${pieces.join(', ') || 'the pieces'} ` +
      'and photographs cleanly under trade-show lighting.',
    paletteHex: ['#E8E4DD', '#CFC8BC', '#2A2A2D'],
    lightingNotes:
      'Soft overhead key at roughly 45 degrees, low-intensity fill from the aisle side to keep ' +
      'shadow detail, and a warm accent grazing the back wall for depth.',
    suggestedProps: ['rug', 'plinth', 'planter'],
  };
}

/* -------------------------------------------------------------------------- */
/* Offline floor-plan-to-scene generation (issue #58)                         */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic stand-in for `generateSceneFromFloorPlan`, used when
 * GEMINI_API_KEY is unset. It cannot see the plan at all, so rather than
 * guess at a boundary or a furniture layout it hands back a plain rectangle
 * sized from the image's own aspect ratio (see `resolveScaleM` - same
 * scaling a manual underlay upload uses) and two placeholder staging props
 * roughly centred in it - enough to open in the studio and confirm the whole
 * upload-generate-stage flow works end to end offline, with issue #52's
 * manual trace and the ordinary "Add a piece" panel left to do the real work
 * once a Gemini key is configured.
 */
export function offlineFloorPlanScene(imageWidthPx: number, imageHeightPx: number): FloorPlanSceneProposal {
  const { widthM, heightM } = resolveScaleM(null, imageWidthPx, imageHeightPx);
  const halfW = widthM / 2;
  const halfH = heightM / 2;
  return {
    boundary: [
      { x: -halfW, z: -halfH },
      { x: halfW, z: -halfH },
      { x: halfW, z: halfH },
      { x: -halfW, z: halfH },
    ],
    widthM,
    heightM,
    placements: [
      { assetName: null, propKind: 'rug', name: null, x: 0, z: 0, rotationDegrees: 0 },
      {
        assetName: null,
        propKind: 'plinth',
        name: null,
        x: 0,
        z: Math.max(0, Math.min(halfH - 0.5, 1.2)),
        rotationDegrees: 0,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Offline studio command parser (issue #60)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic stand-in for `interpretSceneCommand` (lib/ai/gemini.ts), used
 * when GEMINI_API_KEY is unset. It cannot reason about arbitrary phrasing the
 * way a model can, so instead it recognises a handful of common verbs -
 * move/shift/nudge, rotate/turn, scale/resize/bigger/smaller, show/hide,
 * warm up/cool down/brighten/dim, darker/lighter/matte/glossy, add a <prop> -
 * against whichever node they most plausibly refer to (by shared words with
 * the node's name, same scoring `offlineResolvePartReference` already uses).
 *
 * The command is split into clauses on "and"/","/";"/"then" and each clause
 * tried against every recognised verb in a fixed priority order; a clause
 * matching none of them is reported back verbatim in `unresolved` rather than
 * silently dropped. Every raw mutation this produces is run back through the
 * same `normalizeRawMutation` the Gemini path uses, so both paths are held to
 * exactly the same validation rules.
 */
function wordsOf(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Best-scoring node by shared words with `query` (name plus, for a prop, its prop kind). Null when nothing shares even one word. Generic so a caller filtering to e.g. only light nodes keeps that narrowed type on the result. */
function resolveNodeOffline<T extends SceneNode>(query: string, nodes: T[]): T | null {
  const queryWords = wordsOf(query);
  if (queryWords.size === 0 || nodes.length === 0) return null;

  let best: { node: T; score: number } | null = null;
  for (const node of nodes) {
    const haystack = `${node.name} ${node.propKind ?? ''}`;
    const score = [...wordsOf(haystack)].filter((w) => queryWords.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { node, score };
  }
  return best?.node ?? null;
}

/**
 * Same as `resolveNodeOffline`, but falls back to the sole candidate when
 * there is only one and nothing shared a word with it - e.g. "make the
 * cushion matte" names a *material*, not a node, but when exactly one asset
 * is staged there is nothing else it could mean. Ambiguous (2+ candidates,
 * no match) still resolves to nothing rather than guessing.
 */
function resolveNodeOfflineWithFallback<T extends SceneNode>(query: string, nodes: T[]): T | null {
  return resolveNodeOffline(query, nodes) ?? (nodes.length === 1 ? nodes[0] : null);
}

/** Best-scoring material name on `node` by shared words with `clause`. Null when the node has one material (nothing to disambiguate) or nothing shares a word. */
function resolveMaterialNameOffline(clause: string, node: SceneNode, versions: VersionLookup): string | null {
  if (node.kind !== 'asset' || !node.assetVersionId) return null;
  const materials = versions[node.assetVersionId]?.version.spec.materials ?? [];
  if (materials.length <= 1) return null;

  const clauseWords = wordsOf(clause);
  let best: { name: string; score: number } | null = null;
  for (const material of materials) {
    const score = [...wordsOf(material.name)].filter((w) => clauseWords.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { name: material.name, score };
  }
  return best?.name ?? null;
}

const METRE_PATTERN = /([\d]*\.?\d+)\s*(mm|cm|m)\b/i;

function toMetres(amount: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case 'mm':
      return amount / 1000;
    case 'cm':
      return amount / 100;
    default:
      return amount;
  }
}

const PROP_KEYWORDS: Array<{ pattern: RegExp; propKind: string }> = [
  { pattern: /\bplinths?\b/i, propKind: 'plinth' },
  { pattern: /\brugs?\b/i, propKind: 'rug' },
  { pattern: /\bpartitions?\b/i, propKind: 'partition' },
  { pattern: /\bplanters?\b/i, propKind: 'planter' },
  { pattern: /\bside[\s-]?tables?\b/i, propKind: 'side_table' },
  { pattern: /\bfloor[\s-]?lamps?\b/i, propKind: 'floor_lamp' },
];

function offlineAddProp(clause: string): RawSceneMutation[] | null {
  if (!/\badd\b/i.test(clause)) return null;
  const match = PROP_KEYWORDS.find((p) => p.pattern.test(clause));
  if (!match) return null;
  return [{ kind: 'add_prop', propKind: match.propKind, name: null }];
}

function offlineMove(clause: string, doc: SceneDoc): RawSceneMutation[] | null {
  if (!/\b(move|shift|nudge)\b/i.test(clause)) return null;
  const amountMatch = clause.match(METRE_PATTERN);
  const directionMatch = clause.match(/\b(left|right|forwards?|backwards?|back|up|down)\b/i);
  if (!amountMatch || !directionMatch) return null;

  const metres = toMetres(parseFloat(amountMatch[1]), amountMatch[2]);
  const direction = directionMatch[1].toLowerCase();
  const deltaMeters =
    direction === 'left'
      ? { x: -metres, y: 0, z: 0 }
      : direction === 'right'
        ? { x: metres, y: 0, z: 0 }
        : direction === 'up'
          ? { x: 0, y: metres, z: 0 }
          : direction === 'down'
            ? { x: 0, y: -metres, z: 0 }
            : direction.startsWith('forward')
              ? { x: 0, y: 0, z: metres }
              : { x: 0, y: 0, z: -metres };

  const node = resolveNodeOfflineWithFallback(clause, doc.nodes);
  return [{ kind: 'move_node', nodeName: node?.name ?? null, deltaMeters }];
}

function offlineRotate(clause: string, doc: SceneDoc): RawSceneMutation[] | null {
  if (!/\b(rotate|turn|spin)\b/i.test(clause)) return null;
  const degMatch = clause.match(/([\d]*\.?\d+)\s*(?:deg(?:rees)?|°)?/);
  if (!degMatch) return null;

  let degrees = parseFloat(degMatch[1]);
  if (!Number.isFinite(degrees) || degrees === 0) return null;
  if (/\b(right|clockwise|\bcw\b)\b/i.test(clause)) degrees = -Math.abs(degrees);
  else degrees = Math.abs(degrees);

  const node = resolveNodeOfflineWithFallback(clause, doc.nodes);
  return [{ kind: 'rotate_node', nodeName: node?.name ?? null, deltaDegrees: { x: 0, y: degrees, z: 0 } }];
}

function offlineScale(clause: string, doc: SceneDoc): RawSceneMutation[] | null {
  const hasVerb = /\b(scale|resize)\b/i.test(clause);
  const bigger = /\b(bigger|larger|enlarge|grow)\b/i.test(clause);
  const smaller = /\b(smaller|shrink)\b/i.test(clause);
  if (!hasVerb && !bigger && !smaller) return null;

  let factor: number | null = null;
  const pctMatch = clause.match(/([\d]*\.?\d+)\s*%/);
  const multMatch = clause.match(/([\d]*\.?\d+)\s*x\b/i);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]) / 100;
    factor = smaller ? 1 - pct : 1 + pct;
  } else if (multMatch) {
    factor = parseFloat(multMatch[1]);
  } else if (/\bhalf\b/i.test(clause)) {
    factor = 0.5;
  } else if (/\bdouble\b/i.test(clause)) {
    factor = 2;
  } else if (bigger) {
    factor = 1.2;
  } else if (smaller) {
    factor = 0.8;
  }
  if (factor === null || !Number.isFinite(factor) || factor <= 0) return null;

  const node = resolveNodeOfflineWithFallback(clause, doc.nodes);
  return [{ kind: 'scale_node', nodeName: node?.name ?? null, scaleFactor: factor }];
}

function offlineVisibility(clause: string, doc: SceneDoc): RawSceneMutation[] | null {
  const hide = /\b(hide|invisible)\b/i.test(clause);
  const show = /\b(show|visible)\b/i.test(clause);
  if (!hide && !show) return null;

  const node = resolveNodeOfflineWithFallback(clause, doc.nodes);
  return [{ kind: 'set_visibility', nodeName: node?.name ?? null, visible: hide ? false : true }];
}

/** Blend `from` toward `toward` by `t` (0..1). Used for a "warm up"/"cool down" shift, distinct from `mixHex`'s toward-black/white blend. */
function blendHex(from: string, toward: string, t: number): string {
  const a = (/^#[0-9a-f]{6}$/i.test(from) ? from : '#FFFFFF').replace('#', '');
  const b = (/^#[0-9a-f]{6}$/i.test(toward) ? toward : '#FFFFFF').replace('#', '');
  const ratio = Math.min(1, Math.max(0, t));
  const mixed = [0, 2, 4].map((i) => {
    const ca = parseInt(a.slice(i, i + 2), 16);
    const cb = parseInt(b.slice(i, i + 2), 16);
    return Math.round(ca + (cb - ca) * ratio);
  });
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const WARM_REFERENCE_HEX = '#FF9F45';
const COOL_REFERENCE_HEX = '#9FC7FF';

function offlineLight(clause: string, doc: SceneDoc): RawSceneMutation[] | null {
  const warm = /\b(warm|warmer)\b/i.test(clause);
  const cool = /\b(cool|cooler)\b/i.test(clause);
  const brighten = /\b(brighten|brighter)\b/i.test(clause);
  const dim = /\b(dim|dimmer|darken|darker)\b/i.test(clause);
  if (!warm && !cool && !brighten && !dim) return null;

  const lightNodes = doc.nodes.filter(
    (n): n is SceneNode & { light: NonNullable<SceneNode['light']> } => n.kind === 'light' && n.light !== null,
  );
  if (lightNodes.length === 0) return null;

  const named = resolveNodeOffline(clause, lightNodes);
  const targets = named ? [named] : lightNodes;

  return targets.map((node) => {
    const seed = hash(`${node.id}|${clause}`);
    const magnitude = 0.15 + (seed % 11) / 100; // 0.15..0.25, deterministic per (light, clause)
    const colorHex = warm
      ? blendHex(node.light.colorHex, WARM_REFERENCE_HEX, magnitude)
      : cool
        ? blendHex(node.light.colorHex, COOL_REFERENCE_HEX, magnitude)
        : null;
    const intensity = brighten ? node.light.intensity * 1.25 : dim ? node.light.intensity * 0.75 : null;
    return { kind: 'set_light_property', nodeName: node.name, colorHex, intensity, distance: null };
  });
}

function offlineMaterial(clause: string, doc: SceneDoc, versions: VersionLookup): RawSceneMutation[] | null {
  const darker = /\bdarker\b/i.test(clause);
  const lighter = /\blighter\b/i.test(clause);
  const matte = /\b(matte|matt|flat)\b/i.test(clause);
  const glossy = /\b(glossy|gloss|shiny|shinier|polished|lacquered)\b/i.test(clause);
  if (!darker && !lighter && !matte && !glossy) return null;

  const candidates = doc.nodes.filter((n) => n.kind === 'asset' || n.kind === 'prop');
  const node = resolveNodeOfflineWithFallback(clause, candidates);
  if (!node) {
    return [{ kind: 'set_material_override', nodeName: null, materialName: null, baseColorHex: null, roughness: null, metalness: null, finish: null }];
  }

  const materialName = resolveMaterialNameOffline(clause, node, versions);
  const target = resolveMaterialTarget(node, materialName, versions);
  const seed = hash(`${node.id}|${clause}`);
  const magnitude = 0.12 + (seed % 17) / 100; // 0.12..0.28, deterministic per (node, clause)

  const baseColorHex =
    target && darker ? mixHex(target.current.baseColorHex, -magnitude)
    : target && lighter ? mixHex(target.current.baseColorHex, magnitude)
    : null;
  const roughness =
    target && matte ? clamp01(target.current.roughness + magnitude)
    : target && glossy ? clamp01(target.current.roughness - magnitude)
    : null;
  const finish = matte ? 'matte' : glossy ? 'polished' : null;

  return [{ kind: 'set_material_override', nodeName: node.name, materialName, baseColorHex, roughness, metalness: null, finish }];
}

const OFFLINE_COMMAND_PARSERS: Array<
  (clause: string, doc: SceneDoc, versions: VersionLookup) => RawSceneMutation[] | null
> = [
  (clause) => offlineAddProp(clause),
  (clause, doc) => offlineMove(clause, doc),
  (clause, doc) => offlineRotate(clause, doc),
  (clause, doc) => offlineScale(clause, doc),
  (clause, doc) => offlineVisibility(clause, doc),
  (clause, doc) => offlineLight(clause, doc),
  (clause, doc, versions) => offlineMaterial(clause, doc, versions),
];

export function offlineInterpretSceneCommand(
  doc: SceneDoc,
  versions: VersionLookup,
  command: string,
): SceneCommandResult {
  const clauses = command
    .split(/\band\b|\bthen\b|[,;]/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const mutations: SceneCommandResult['mutations'] = [];
  const unresolved: string[] = [];

  for (const clause of clauses) {
    let raws: RawSceneMutation[] | null = null;
    for (const parser of OFFLINE_COMMAND_PARSERS) {
      raws = parser(clause, doc, versions);
      if (raws) break;
    }
    if (!raws || raws.length === 0) {
      unresolved.push(clause);
      continue;
    }
    for (const raw of raws) {
      const result = normalizeRawMutation(raw, doc);
      if ('problem' in result) unresolved.push(result.problem);
      else mutations.push(result);
    }
  }

  return { mutations, unresolved };
}
