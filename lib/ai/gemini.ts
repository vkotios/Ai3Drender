import { GoogleGenAI } from '@google/genai';

import { env, hasGemini } from '@/lib/env';
import type { FurnitureSpec, MaterialLibraryEntry, MaterialSpec, SceneDirection } from '@/lib/types';

import { offlineFurnitureSpec, offlineSceneDirection } from './offline';
import { FURNITURE_SPEC_SCHEMA, SCENE_DIRECTION_SCHEMA } from './schemas';

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
/* 3. Brief -> exhibition art direction                                       */
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
/* 4. Natural-language refinement of an existing spec                         */
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
/* 5. Fast photoreal concept pass over a viewport capture                     */
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
