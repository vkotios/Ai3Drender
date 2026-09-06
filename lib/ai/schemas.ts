/**
 * Response schemas handed to Gemini for structured output.
 *
 * These are OpenAPI-3.0-subset Schema objects. Type names are the SDK's string
 * enum values, which keeps this module free of a runtime SDK import so it can
 * also be read by the offline analyzer.
 */

const hex = { type: 'STRING', description: 'CSS hex colour, e.g. #8B5A2B' } as const;

const dimensions = {
  type: 'OBJECT',
  description: 'Overall bounding size of the piece in millimetres.',
  properties: {
    widthMm: { type: 'NUMBER', description: 'Left-to-right extent.' },
    depthMm: { type: 'NUMBER', description: 'Front-to-back extent.' },
    heightMm: { type: 'NUMBER', description: 'Floor to highest point.' },
  },
  required: ['widthMm', 'depthMm', 'heightMm'],
} as const;

const material = {
  type: 'OBJECT',
  properties: {
    id: { type: 'STRING', description: 'Short stable slug, e.g. "oak_frame".' },
    name: { type: 'STRING' },
    kind: {
      type: 'STRING',
      format: 'enum',
      enum: ['wood', 'metal', 'fabric', 'leather', 'glass', 'stone', 'plastic', 'composite'],
    },
    baseColorHex: hex,
    roughness: { type: 'NUMBER', description: '0 mirror-smooth to 1 fully diffuse.' },
    metalness: { type: 'NUMBER', description: '1 only for bare metal, else 0.' },
    sheen: { type: 'NUMBER', description: 'Fabric rim response, 0 for hard materials.' },
    clearcoat: { type: 'NUMBER', description: 'Lacquer layer, e.g. 0.8 for polished wood.' },
    finish: { type: 'STRING', description: 'e.g. "brushed", "oiled walnut", "powder-coated".' },
    notes: { type: 'STRING' },
    libraryMatchId: {
      type: 'STRING',
      nullable: true,
      description:
        'The id of the candidate material (from the "Known materials" list, if one was ' +
        'supplied) that this surface actually is. Null when none of the candidates match and ' +
        'this is a genuinely new material. Set this whenever a candidate is a real match, even ' +
        'an approximate one - do not leave it null just because the photo shows a slightly ' +
        'different crop or lighting of the same material.',
    },
  },
  required: ['id', 'name', 'kind', 'baseColorHex', 'roughness', 'metalness', 'finish'],
} as const;

export const FURNITURE_SPEC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    displayName: { type: 'STRING', description: 'Short product-style name.' },
    category: { type: 'STRING', description: 'e.g. "lounge chair", "extending dining table".' },
    summary: { type: 'STRING', description: 'Two sentences describing form and construction.' },
    dimensions,
    seatHeightMm: {
      type: 'NUMBER',
      nullable: true,
      description: 'Floor to seat surface. Null for pieces without a seat.',
    },
    dimensionConfidence: {
      type: 'STRING',
      format: 'enum',
      enum: ['stated', 'estimated', 'rough'],
      description:
        'stated = a dimension was legible in the photos; estimated = inferred from a ' +
        'recognisable reference; rough = inferred from category conventions only.',
    },
    components: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          role: {
            type: 'STRING',
            description: 'e.g. seat, backrest, armrest, leg, frame, cushion, top, shelf.',
          },
          materialId: { type: 'STRING', description: 'Must match a materials[].id.' },
          approxSizeMm: dimensions,
        },
        required: ['name', 'role', 'materialId', 'approxSizeMm'],
      },
    },
    materials: { type: 'ARRAY', items: material },
    palette: { type: 'ARRAY', items: hex, description: 'Ordered by visual weight.' },
    styleTags: { type: 'ARRAY', items: { type: 'STRING' } },
    symmetry: { type: 'STRING', format: 'enum', enum: ['bilateral', 'radial', 'none'] },
    reconstructionNotes: {
      type: 'STRING',
      description:
        'Guidance for a photo-to-3D reconstruction model: which silhouette details matter, ' +
        'where geometry is thin or perforated, what must not be simplified away.',
    },
  },
  required: [
    'displayName',
    'category',
    'summary',
    'dimensions',
    'dimensionConfidence',
    'components',
    'materials',
    'palette',
    'styleTags',
    'symmetry',
    'reconstructionNotes',
  ],
} as const;

export const QA_RESULT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: {
      type: 'NUMBER',
      description:
        '0 to 100 fidelity score: how closely the rendered mesh views match the source ' +
        'photographs in silhouette, proportions, materials and colour. 100 = indistinguishable ' +
        'from the photos; 0 = no resemblance at all.',
    },
    issues: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'Specific mismatches between the mesh and the photos, e.g. "missing armrest", ' +
        '"legs are too thick", "seat cushion is the wrong colour". Empty array when the mesh ' +
        'is a faithful match.',
    },
  },
  required: ['score', 'issues'],
} as const;

/**
 * Just the PBR fields, for a targeted single-material correction
 * (`correctMaterial` in lib/ai/gemini.ts). Deliberately narrower than
 * `material` above: id/kind/name/notes are not the model's to change here,
 * so asking it to echo them back only invites drift.
 */
export const MATERIAL_CORRECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    baseColorHex: hex,
    roughness: { type: 'NUMBER', description: '0 mirror-smooth to 1 fully diffuse.' },
    metalness: { type: 'NUMBER', description: '1 only for bare metal, else 0.' },
    sheen: { type: 'NUMBER', description: 'Fabric rim response, 0 for hard materials.' },
    clearcoat: { type: 'NUMBER', description: 'Lacquer layer, e.g. 0.8 for polished wood.' },
    finish: { type: 'STRING', description: 'e.g. "brushed", "oiled walnut", "powder-coated".' },
  },
  required: ['baseColorHex', 'roughness', 'metalness', 'sheen', 'clearcoat', 'finish'],
} as const;

export const SCENE_DIRECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    concept: { type: 'STRING', description: 'One line naming the staging concept.' },
    rationale: { type: 'STRING', description: 'Why this staging suits these pieces.' },
    paletteHex: { type: 'ARRAY', items: hex, description: 'Booth surfaces, not the furniture.' },
    lightingNotes: { type: 'STRING' },
    suggestedProps: {
      type: 'ARRAY',
      items: {
        type: 'STRING',
        format: 'enum',
        enum: ['plinth', 'rug', 'partition', 'planter', 'side_table', 'floor_lamp'],
      },
    },
  },
  required: ['concept', 'rationale', 'paletteHex', 'lightingNotes', 'suggestedProps'],
} as const;
