import { GoogleGenAI } from '@google/genai';

import { env, hasGemini } from '@/lib/env';
import type { VersionLookup } from '@/lib/scene/collisions';
import {
  normalizeRawMutation,
  summarizeSceneForCommand,
  type RawSceneMutation,
  type SceneCommandResult,
  type SceneMutation,
} from '@/lib/scene/command';
import type { FurnitureSpec, MaterialLibraryEntry, MaterialSpec, QaResult, SceneDirection, SceneDoc } from '@/lib/types';

import {
  offlineFurnitureSpec,
  offlineInterpretSceneCommand,
  offlineMaterialCorrection,
  offlineQaResult,
  offlineResolvePartReference,
  offlineSceneDirection,
} from './offline';
import {
  FURNITURE_SPEC_SCHEMA,
  MATERIAL_CORRECTION_SCHEMA,
  PART_REFERENCE_SCHEMA,
  QA_RESULT_SCHEMA,
  SCENE_COMMAND_SCHEMA,
  SCENE_DIRECTION_SCHEMA,
} from './schemas';

export interface ImageInput {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  /** 'mood' images inform art direction but are never reconstructed. */
  role: string;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
}

let client: GoogleGenAI | null = null;

function ai(): GoogleGenAI {
  if (!env.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');
  client ??= new GoogleGenAI({ apiKey: env.geminiApiKey });
  return client;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const imagePart = (image: ImageInput) => ({
  inlineData: { mimeType: image.mimeType, data: toBase64(image.bytes) },
});

/**
 * Gemini occasionally wraps JSON in a fenced block even under a response
 * schema. Strip the fence before parsing rather than failing the whole job.
 */
function parseJson<T>(text: string, what: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch (cause) {
    throw new Error(`${what}: model did not return valid JSON`, { cause });
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Photo -> structured furniture spec                                      */
/* -------------------------------------------------------------------------- */

const ANALYSIS_PROMPT = `
You are a technical specialist at a furniture manufacturer, preparing a piece for
3D reconstruction and trade-show visualisation.

Study the supplied photographs of a SINGLE piece of furniture and produce its
specification.

Rules:
- Report dimensions in millimetres. If a dimension is printed on a spec sheet or
  tag in a photo, use it and set dimensionConfidence to "stated". If you can
  scale from a reliable in-frame reference, use "estimated". Otherwise fall back
  to conventions for the category and use "rough". Never invent precision.
- Give every distinct surface its own material entry. Assign metalness 1.0 only
  to bare metal; painted or powder-coated metal is a dielectric (metalness 0)
  with a low-to-mid roughness.
- Every components[].materialId must match one of the materials[].id values.
- reconstructionNotes is read by a photo-to-3D model. Call out thin members,
  perforations, gaps that must stay open, and any detail that a naive
  reconstruction would smooth away.
`.trim();

const LIBRARY_MATCHING_RULES = `
This manufacturer keeps a catalogue of the real materials it actually uses - fixed
timbers, fabrics, leathers and finishes, each with a settled colour and surface
response. Before describing a new material yourself, check it against the "Known
materials" list below.

- If a surface in the photos is one of these known materials (even if lighting or
  crop makes it look slightly different here), set that material's libraryMatchId to
  the candidate's id, and set its own name/kind/finish to match the candidate - do
  not invent a slightly different variant of a material that already exists.
- Only leave libraryMatchId null when the surface genuinely is not one of the listed
  materials. New materials are expected and fine when that is true - never force a
  match that is not real.
`.trim();

function formatLibraryCandidates(candidates: MaterialLibraryEntry[]): string {
  if (candidates.length === 0) return '';
  const rows = candidates
    .map(
      (c) =>
        `- id "${c.id}": ${c.name}${c.code ? ` (${c.code})` : ''} - ${c.kind}, ${c.finish}, ` +
        `colour ${c.baseColorHex}`,
    )
    .join('\n');
  return `${LIBRARY_MATCHING_RULES}\n\nKnown materials:\n${rows}`;
}

/** A material as Gemini actually returns it: MaterialSpec plus the match field. */
type RawMaterial = MaterialSpec & { libraryMatchId?: string | null };

/**
 * Resolve each material's `libraryMatchId` against the candidates that were
 * offered. A matched material's PBR fields are overwritten with the library
 * entry's canonical values - the whole point is that every piece bound to the
 * same entry renders identically, not merely similarly - rather than trusting
 * whatever the model echoed back for them.
 */
function resolveLibraryMatches(
  spec: FurnitureSpec,
  candidates: MaterialLibraryEntry[],
): FurnitureSpec {
  if (candidates.length === 0) return spec;
  const byId = new Map(candidates.map((c) => [c.id, c]));

  return {
    ...spec,
    materials: (spec.materials as RawMaterial[]).map(({ libraryMatchId, ...material }) => {
      const candidate = libraryMatchId ? byId.get(libraryMatchId) : undefined;
      if (!candidate) return { ...material, libraryEntryId: null, invented: true };
      return {
        ...material,
        name: candidate.name,
        kind: candidate.kind,
        baseColorHex: candidate.baseColorHex,
        roughness: candidate.roughness,
        metalness: candidate.metalness,
        sheen: candidate.sheen,
        clearcoat: candidate.clearcoat,
        finish: candidate.finish,
        libraryEntryId: candidate.id,
        invented: false,
      };
    }),
  };
}

export async function analyzeFurniture(
  images: ImageInput[],
  brief?: string | null,
  /**
   * The account's known materials, offered as candidates so the model matches
   * against real materials instead of re-inventing a near-miss of one that
   * already exists. Pass an empty array (the default) when there is no
   * library yet, or none configured - every material is then treated as
   * invented, exactly as before this existed.
   */
  libraryCandidates: MaterialLibraryEntry[] = [],
): Promise<{ spec: FurnitureSpec; source: 'gemini' | 'offline' }> {
  const usable = images.filter((i) => i.role !== 'mood');
  if (!hasGemini || usable.length === 0) {
    return {
      spec: offlineFurnitureSpec(images.map((i) => i.filename), brief, libraryCandidates),
      source: 'offline',
    };
  }

  const candidateBlock = formatLibraryCandidates(libraryCandidates);

  const response = await ai().models.generateContent({
    model: env.geminiTextModel,
    contents: [
      {
        role: 'user',
        parts: [
          { text: ANALYSIS_PROMPT },
          ...(candidateBlock ? [{ text: candidateBlock }] : []),
          ...(brief ? [{ text: `Project art direction, for context only:\n${brief}` }] : []),
          ...usable.map(imagePart),
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: FURNITURE_SPEC_SCHEMA as never,
      temperature: 0.2,
    },
  });

  const spec = parseJson<FurnitureSpec>(response.text ?? '', 'analyzeFurniture');
  const resolved = resolveLibraryMatches(spec, libraryCandidates);
  return { spec: normalizeSpec(resolved), source: 'gemini' };
}

/**
 * Guard the downstream renderer against out-of-range or inconsistent values.
 * The schema constrains shape but not physical plausibility.
 */
function normalizeSpec(spec: FurnitureSpec): FurnitureSpec {
  const clamp = (n: number, lo: number, hi: number) =>
    Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

  const materials = (spec.materials ?? []).map((m) => ({
    ...m,
    roughness: clamp(m.roughness, 0, 1),
    metalness: clamp(m.metalness, 0, 1),
    sheen: clamp(m.sheen ?? 0, 0, 1),
    clearcoat: clamp(m.clearcoat ?? 0, 0, 1),
    baseColorHex: /^#[0-9a-f]{6}$/i.test(m.baseColorHex) ? m.baseColorHex : '#9a9a9a',
  }));
  const fallbackMaterialId = materials[0]?.id ?? 'default';

  return {
    ...spec,
    dimensions: {
      widthMm: clamp(spec.dimensions?.widthMm, 50, 6000),
      depthMm: clamp(spec.dimensions?.depthMm, 50, 6000),
      heightMm: clamp(spec.dimensions?.heightMm, 50, 3000),
    },
    seatHeightMm: spec.seatHeightMm ? clamp(spec.seatHeightMm, 100, 1200) : null,
    materials,
    components: (spec.components ?? []).map((c) => ({
      ...c,
      // A dangling materialId would leave the part untextured in the viewer.
      materialId: materials.some((m) => m.id === c.materialId) ? c.materialId : fallbackMaterialId,
    })),
    palette: (spec.palette ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)),
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Photo -> clean multi-view sheet for reconstruction                      */
/* -------------------------------------------------------------------------- */

/** Canonical cameras a photo-to-3D model reconstructs best from. */
export const CANONICAL_ANGLES = [
  'front',
  'three_quarter_left',
  'side_left',
  'back',
  'three_quarter_right',
] as const;

export type CanonicalAngle = (typeof CANONICAL_ANGLES)[number];

const ANGLE_DESCRIPTIONS: Record<CanonicalAngle, string> = {
  front: 'straight-on front elevation, camera at the midpoint of the piece height',
  three_quarter_left: 'three-quarter view from 45 degrees to the front-left',
  side_left: 'straight-on left side elevation',
  back: 'straight-on rear elevation',
  three_quarter_right: 'three-quarter view from 45 degrees to the front-right',
};

/**
 * Synthesize a consistent turntable of the piece.
 *
 * Reconstruction quality is dominated by how many consistent viewpoints the
 * vendor gets. Customers usually supply one or two marketing shots, so we ask
 * the image model to re-render the same piece from the canonical angles on a
 * plain background before handing anything to the mesh vendor.
 */
export async function synthesizeViews(
  images: ImageInput[],
  spec: FurnitureSpec,
  angles: readonly CanonicalAngle[] = CANONICAL_ANGLES,
): Promise<{ angle: CanonicalAngle; image: GeneratedImage }[]> {
  if (!hasGemini) return [];

  const references = images.filter((i) => i.role !== 'mood').map(imagePart);
  if (references.length === 0) return [];

  const results: { angle: CanonicalAngle; image: GeneratedImage }[] = [];

  // Sequential rather than parallel: each request carries several full-size
  // reference images, and image endpoints rate-limit aggressively on burst.
  for (const angle of angles) {
    const prompt = `
Re-render the EXACT piece of furniture shown in the reference photographs, seen from a
${ANGLE_DESCRIPTIONS[angle]}.

This image is input to a photo-to-3D reconstruction model, so:
- Keep proportions, materials, colours and every construction detail identical to the
  references. Invent nothing; if a face is not visible in the references, infer it from
  the piece's symmetry (${spec.symmetry}) and nothing else.
- Plain neutral mid-grey background, no floor line, no shadow cast on the background.
- Even, soft, shadowless studio lighting. No dramatic highlights.
- The whole piece in frame, centred, orthographic-looking with minimal perspective.
- No people, props, text, watermarks or set dressing.

The piece is a ${spec.category}: ${spec.summary}
${spec.reconstructionNotes}
`.trim();

    const response = await ai().models.generateContent({
      model: env.geminiImageModel,
      contents: [{ role: 'user', parts: [{ text: prompt }, ...references] }],
      config: { responseModalities: ['IMAGE'] },
    });

    const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (part?.inlineData?.data) {
      results.push({
        angle,
        image: {
          bytes: new Uint8Array(Buffer.from(part.inlineData.data, 'base64')),
          mimeType: part.inlineData.mimeType ?? 'image/png',
        },
      });
    }
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* 3. Perceptual QA: does the mesh actually look like the photos?             */
/* -------------------------------------------------------------------------- */

const QA_PROMPT = `
You are a quality inspector at a furniture manufacturer, checking a freshly reconstructed
3D model against the photographs of the real piece it was built from.

You are shown two sets of images:
1. The ORIGINAL PHOTOGRAPHS of the physical piece.
2. RENDERED VIEWS of the reconstructed 3D mesh, from a few stock camera angles.

Compare them and judge how faithfully the mesh reproduces the piece in the photos.

Rules:
- Score fidelity from 0 (no resemblance) to 100 (matches the photos closely) considering
  silhouette, proportions, materials/colour and any visible construction detail.
- Ignore rendering differences that are not the mesh's fault: the renders use flat studio
  shading with no environment, so lighting, background and photographic finish never count
  against the score.
- List only concrete, specific mismatches (e.g. "missing left armrest", "legs read much
  thicker than in the photos", "seat cushion is grey instead of the photographed tan"). Do
  not restate the score as an issue, and leave the list empty when the mesh is a faithful
  match.
`.trim();

/**
 * Ask Gemini vision whether a reconstructed mesh actually looks like the
 * photos it was built from - a perceptual check on top of gltf-transform's
 * purely structural round-trip (valid glTF, sane triangle counts).
 *
 * Always a soft signal: the caller stores whatever comes back on the
 * AssetVersion and the UI surfaces it as a warning, never as a blocker on
 * accepting or using the version (a reconstruction vendor outage or a model
 * refusal here must not stop a piece from shipping).
 */
export async function evaluateReconstruction(
  sourcePhotos: ImageInput[],
  meshViews: { angle: string; image: GeneratedImage }[],
  spec: Pick<FurnitureSpec, 'displayName' | 'category' | 'summary'>,
): Promise<QaResult> {
  const usablePhotos = sourcePhotos.filter((i) => i.role !== 'mood');
  if (!hasGemini || usablePhotos.length === 0 || meshViews.length === 0) {
    return offlineQaResult();
  }

  const response = await ai().models.generateContent({
    model: env.geminiTextModel,
    contents: [
      {
        role: 'user',
        parts: [
          { text: QA_PROMPT },
          { text: `The piece is a ${spec.category}: ${spec.displayName}. ${spec.summary}` },
          { text: 'Original photographs:' },
          ...usablePhotos.map(imagePart),
          { text: 'Rendered views of the reconstructed mesh:' },
          ...meshViews.map((v) => ({ inlineData: { mimeType: v.image.mimeType, data: toBase64(v.image.bytes) } })),
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: QA_RESULT_SCHEMA as never,
      temperature: 0.1,
    },
  });

  const parsed = parseJson<{ score: number; issues: string[] }>(response.text ?? '', 'evaluateReconstruction');
  const score = Number.isFinite(parsed.score) ? Math.min(100, Math.max(0, parsed.score)) : 0;
  return {
    score,
    issues: Array.isArray(parsed.issues) ? parsed.issues.filter(Boolean) : [],
    source: 'gemini',
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Brief -> exhibition art direction                                       */
/* -------------------------------------------------------------------------- */

export async function directScene(
  specs: FurnitureSpec[],
  brief?: string | null,
): Promise<SceneDirection> {
  const names = specs.map((s) => s.displayName);
  if (!hasGemini) return offlineSceneDirection(names);

  const inventory = specs
    .map(
      (s) =>
        `- ${s.displayName} (${s.category}), ${s.dimensions.widthMm}x${s.dimensions.depthMm}x` +
        `${s.dimensions.heightMm}mm, materials: ${s.materials.map((m) => m.name).join(', ')}, ` +
        `style: ${s.styleTags.join(', ')}`,
    )
    .join('\n');

  const response = await ai().models.generateContent({
    model: env.geminiTextModel,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `
You are staging a furniture manufacturer's stand at a trade exhibition.

Pieces on the stand:
${inventory}

${brief ? `Client brief:\n${brief}\n` : ''}
Propose the booth treatment. Choose booth surface colours that flatter these pieces
without competing with them, and describe lighting a photographer would actually rig.
Keep the prop list to what genuinely helps the pieces read.
`.trim(),
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: SCENE_DIRECTION_SCHEMA as never,
      temperature: 0.7,
    },
  });

  return parseJson<SceneDirection>(response.text ?? '', 'directScene');
}

/* -------------------------------------------------------------------------- */
/* 5. Natural-language refinement of an existing spec                         */
/* -------------------------------------------------------------------------- */

/**
 * Apply a plain-language change ("make the legs walnut, 60mm lower") to a spec.
 * Returns the full revised spec so the caller can store it as a new version.
 */
export async function refineSpec(
  spec: FurnitureSpec,
  instruction: string,
  /**
   * Notes pinned to specific points on the geometry, already formatted with
   * the part and location they refer to. These carry far more signal than the
   * free-text instruction, so they are presented first.
   */
  anchoredNotes: string[] = [],
): Promise<FurnitureSpec> {
  if (!hasGemini) {
    // Without a model we can still record the request; the spec is unchanged
    // and the caller surfaces that to the user.
    return spec;
  }

  const notesBlock =
    anchoredNotes.length > 0
      ? `\nNotes pinned to specific points on the piece:\n${anchoredNotes.join('\n')}\n`
      : '';

  const response = await ai().models.generateContent({
    model: env.geminiTextModel,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `
Revise this furniture specification according to the requested changes.

Change only what the requests imply. Preserve every other field exactly, including
ids, so that downstream material bindings keep working. Keep dimensions in millimetres
and physically plausible.

Each pinned note names the part it is attached to and where that part sits on the
piece. Apply a note to that part specifically - do not apply it to the whole piece
unless the note says so. If a note asks for something that would make the piece
unbuildable or unstable, apply the closest sound alternative and say what you did in
reconstructionNotes.

${notesBlock}${instruction ? `Requested change:\n${instruction}\n` : ''}
Current specification:
${JSON.stringify(spec, null, 2)}
`.trim(),
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: FURNITURE_SPEC_SCHEMA as never,
      temperature: 0.2,
    },
  });

  return normalizeSpec(parseJson<FurnitureSpec>(response.text ?? '', 'refineSpec'));
}

/* -------------------------------------------------------------------------- */
/* 6. Spot-fix one material's PBR values from a free-text instruction         */
/* -------------------------------------------------------------------------- */

export type MaterialCorrection = Pick<
  MaterialSpec,
  'baseColorHex' | 'roughness' | 'metalness' | 'sheen' | 'clearcoat' | 'finish' | 'notes'
>;

/**
 * Apply a plain-language correction ("make this darker walnut") to ONE
 * material's PBR values, without touching the spec or mesh around it.
 *
 * This is the lighter counterpart to `refineSpec`: same "describe the change,
 * get structured values back" shape, but scoped to a single material entry
 * rather than the whole furniture spec, so a wrong colour or finish doesn't
 * force a full note-and-revise round that also touches the mesh. See the
 * material rebind route (`PATCH .../materials/:materialId`), which calls this
 * for a free-text `instruction` the same way it already calls the material
 * library for a `libraryEntryId`.
 */
export async function correctMaterial(
  material: MaterialSpec,
  instruction: string,
): Promise<MaterialCorrection> {
  if (!hasGemini) return offlineMaterialCorrection(material, instruction);

  const response = await ai().models.generateContent({
    model: env.geminiTextModel,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `
Adjust ONLY the physically-based rendering values below for one furniture material, so
it matches the requested correction. This is a targeted colour/finish fix to a single
material, not a redesign - do not change kind, and change roughness/metalness/sheen/
clearcoat only as far as the requested finish actually implies.

Current material:
${JSON.stringify(
  {
    name: material.name,
    kind: material.kind,
    baseColorHex: material.baseColorHex,
    roughness: material.roughness,
    metalness: material.metalness,
    sheen: material.sheen,
    clearcoat: material.clearcoat,
    finish: material.finish,
  },
  null,
  2,
)}

Requested correction:
${instruction}
`.trim(),
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: MATERIAL_CORRECTION_SCHEMA as never,
      temperature: 0.3,
    },
  });

  const parsed = parseJson<Omit<MaterialCorrection, 'notes'>>(response.text ?? '', 'correctMaterial');
  const clamp = (n: number, lo: number, hi: number) =>
    Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

  return {
    baseColorHex: /^#[0-9a-f]{6}$/i.test(parsed.baseColorHex) ? parsed.baseColorHex : material.baseColorHex,
    roughness: clamp(parsed.roughness, 0, 1),
    metalness: clamp(parsed.metalness, 0, 1),
    sheen: clamp(parsed.sheen ?? material.sheen, 0, 1),
    clearcoat: clamp(parsed.clearcoat ?? material.clearcoat, 0, 1),
    finish: parsed.finish || material.finish,
    notes: `Spot-fixed via Gemini per instruction: "${instruction.trim()}".`,
  };
}

/* -------------------------------------------------------------------------- */
/* 6b. Resolve a free-text part reference against the piece's named parts     */
/* -------------------------------------------------------------------------- */

/**
 * Match a free-text description of one part of a piece ("the legs", "the
 * cushion on top") to one of its named spec components, for a `rebake_part`
 * request whose target didn't match a component/node name exactly - see
 * `resolveComponent` in lib/scene/anchor.ts, which this is the AI-assisted
 * fallback for (issue #57).
 *
 * Text-only, not vision: the component list alone is almost always enough to
 * disambiguate ("the legs" is unambiguous against ["Legs", "Seat",
 * "Backrest"]), so this stays as light a call as `correctMaterial` rather
 * than paying for an image round-trip. Returns null - never a guess - when
 * the model itself says nothing matches, or names something not in the list.
 */
export async function resolvePartReference(
  query: string,
  parts: { name: string; role: string }[],
): Promise<string | null> {
  if (parts.length === 0) return null;
  if (!hasGemini) return offlineResolvePartReference(query, parts);

  const response = await ai().models.generateContent({
    model: env.geminiTextModel,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `
A user described one part of a furniture piece in their own words. Match their description to
exactly one of the piece's named components below, or say none of them plausibly match.

Named components:
${parts.map((p) => `- "${p.name}" (role: ${p.role})`).join('\n')}

User's description: "${query}"
`.trim(),
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: PART_REFERENCE_SCHEMA as never,
      temperature: 0,
    },
  });

  const parsed = parseJson<{ partName: string | null }>(response.text ?? '', 'resolvePartReference');
  return parts.find((p) => p.name === parsed.partName)?.name ?? null;
}

/* -------------------------------------------------------------------------- */
/* 6c. Natural-language studio command -> a closed set of scene mutations     */
/* -------------------------------------------------------------------------- */

/**
 * Turn a free-text studio command ("move the sofa 30cm left and warm up the
 * lighting") into an ordered list of concrete mutations drawn from a CLOSED,
 * explicit set - see `SCENE_MUTATION_KINDS` in lib/scene/command.ts. This is
 * issue #60, deliberately scoped to a single structured call for the app's
 * own operator, never an open-ended agentic tool-use loop or an external MCP
 * integration - same "free text in, small structured object out" shape as
 * `correctMaterial`/`resolvePartReference` above.
 *
 * This function only interprets - it never touches the document. The route
 * (`POST /api/scenes/:sceneId/command`) is what calls `applySceneMutations`
 * with the result and saves it back through the ordinary scene-save path.
 */
export async function interpretSceneCommand(
  doc: SceneDoc,
  versions: VersionLookup,
  command: string,
): Promise<SceneCommandResult> {
  if (!hasGemini) return offlineInterpretSceneCommand(doc, versions, command);

  const response = await ai().models.generateContent({
    model: env.geminiTextModel,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `
You are translating one operator's plain-language staging instruction into a small, ordered
list of concrete edits to a furniture exhibition stand, using ONLY a closed set of supported
edit kinds. Never invent a kind of edit that is not listed below, and never invent a node,
material or prop kind that is not listed for this stand.

Supported mutation kinds:
- move_node: nudge a staged piece by a position delta.
- rotate_node: turn a staged piece by a rotation delta.
- scale_node: resize a staged piece by a multiplier.
- set_material_override: change one material's colour/roughness/metalness/finish on a piece,
  without touching the underlying product specification.
- set_light_property: change a light's colour, intensity or falloff distance.
- set_visibility: show or hide a piece.
- add_prop: add one new simple staging prop (plinth, rug, partition, planter, side table or
  floor lamp).

Coordinate convention: +X is to the right and -X is to the left, as seen from the aisle camera
facing the booth. +Z is toward the aisle/camera (the front, nearer the viewer) and -Z is toward
the back wall (farther from the viewer). +Y is up. Convert any distance given in cm or mm to
metres, and any rotation given in a unit other than degrees to degrees.

Staged nodes on this stand:
${summarizeSceneForCommand(doc, versions)}

Operator's command: "${command}"

Every distinct part of the command that doesn't map onto exactly one of the supported kinds
above, or that names a piece/material not listed above, goes into "unresolved" in the
operator's own words instead of being guessed at.
`.trim(),
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: SCENE_COMMAND_SCHEMA as never,
      temperature: 0.2,
    },
  });

  const parsed = parseJson<{ mutations: RawSceneMutation[]; unresolved: string[] }>(
    response.text ?? '',
    'interpretSceneCommand',
  );

  const mutations: SceneMutation[] = [];
  const unresolved = Array.isArray(parsed.unresolved) ? parsed.unresolved.filter(Boolean) : [];
  for (const raw of Array.isArray(parsed.mutations) ? parsed.mutations : []) {
    const result = normalizeRawMutation(raw, doc);
    if ('problem' in result) unresolved.push(result.problem);
    else mutations.push(result);
  }
  return { mutations, unresolved };
}

/* -------------------------------------------------------------------------- */
/* 7. Fast photoreal concept pass over a viewport capture                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-render a viewport capture photorealistically.
 *
 * This is the quick option: seconds rather than minutes, and useful as a
 * starting point for art direction. It is NOT geometrically faithful - an
 * image model will happily invent joinery, restyle a leg or move a seam. It
 * must never be presented to a buyer as a representation of the product, and
 * the UI labels it accordingly.
 */
export async function conceptRender(
  capture: { bytes: Uint8Array; mimeType: string },
  options: {
    pieces: FurnitureSpec[];
    brief?: string | null;
    instruction?: string | null;
  },
): Promise<GeneratedImage> {
  if (!hasGemini) throw new Error('GEMINI_API_KEY is required for concept renders');

  const inventory = options.pieces
    .map(
      (spec) =>
        `- ${spec.displayName} (${spec.category}): ${spec.materials
          .map((m) => `${m.name}, ${m.finish}`)
          .join('; ')}`,
    )
    .join('\n');

  const prompt = `
This is a real-time preview of a furniture manufacturer's exhibition stand. Re-render it
as a photograph of that same stand.

Hold these fixed - they are the product, not the styling:
- The exact geometry, proportions and dimensions of every piece.
- The exact layout: which piece is where, facing which way, at what spacing.
- The materials and colours listed below.
- The camera position and framing.

Change only the rendering: real photographic lighting with soft shadows and accurate
bounce, believable material response, subtle depth of field, and the surface detail a
camera would capture - fabric weave, timber grain, the sheen of a finish.

Add no furniture, props, people, text or signage that is not already in the image.

Pieces on the stand:
${inventory}
${options.brief ? `\nProject art direction:\n${options.brief}` : ''}
${options.instruction ? `\nAdditional direction for this render:\n${options.instruction}` : ''}
`.trim();

  const response = await ai().models.generateContent({
    model: env.geminiImageModel,
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: capture.mimeType, data: toBase64(capture.bytes) } },
        ],
      },
    ],
    config: { responseModalities: ['IMAGE'] },
  });

  const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) {
    throw new Error('The image model returned no image');
  }

  return {
    bytes: new Uint8Array(Buffer.from(part.inlineData.data, 'base64')),
    mimeType: part.inlineData.mimeType ?? 'image/png',
  };
}
