import type { FurnitureSpec, MaterialLibraryEntry, MaterialSpec, SceneDirection } from '@/lib/types';

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
