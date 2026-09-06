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

/** See `resolvePartReference` in lib/ai/gemini.ts (issue #57). */
export const PART_REFERENCE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    partName: {
      type: 'STRING',
      nullable: true,
      description:
        'The exact name of the matching component, copied verbatim from the "Named components" ' +
        'list. Null when none of them plausibly match the description - do not invent a name.',
    },
  },
  required: ['partName'],
} as const;

/**
 * One edit produced by `interpretSceneCommand` (lib/ai/gemini.ts, issue #60).
 *
 * A flat object carrying every field any supported mutation kind might use,
 * almost all nullable - Gemini's structured-output schema (an OpenAPI 3.0
 * subset) has no good way to express "this field only applies when `kind` is
 * X" as a discriminated union, so the wire shape stays flat and
 * `normalizeRawMutation` (lib/scene/command.ts) is what actually enforces
 * which fields matter for which kind. Keep this list of kinds CLOSED - see
 * `SCENE_MUTATION_KINDS` in that same module, the single source of truth this
 * mirrors.
 */
export const SCENE_MUTATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: {
      type: 'STRING',
      format: 'enum',
      enum: [
        'move_node',
        'rotate_node',
        'scale_node',
        'set_material_override',
        'set_light_property',
        'set_visibility',
        'add_prop',
      ],
    },
    nodeName: {
      type: 'STRING',
      nullable: true,
      description:
        'The exact name of the staged node this mutation targets, copied verbatim from the ' +
        '"Staged nodes" list. Null for add_prop (which creates a new node instead of targeting ' +
        'one), or when no listed node plausibly matches - never invent a name.',
    },
    deltaMeters: {
      type: 'OBJECT',
      nullable: true,
      properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, z: { type: 'NUMBER' } },
      description:
        "move_node only: metres to ADD to the node's current position (a delta, not an " +
        'absolute position). +X is right, -X is left, +Z is toward the aisle/camera (front), ' +
        '-Z is toward the back wall, +Y is up. Convert cm/mm in the instruction to metres.',
    },
    deltaDegrees: {
      type: 'OBJECT',
      nullable: true,
      properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, z: { type: 'NUMBER' } },
      description:
        "rotate_node only: degrees to ADD to the node's current rotation about each axis (a " +
        'delta, not an absolute angle). Turning left/right as seen from above is the Y axis.',
    },
    scaleFactor: {
      type: 'NUMBER',
      nullable: true,
      description:
        "scale_node only: multiplier applied to the node's CURRENT scale on every axis - e.g. " +
        '1.2 for "20% bigger", 0.5 for "half the size". Not an absolute scale value.',
    },
    materialName: {
      type: 'STRING',
      nullable: true,
      description:
        "set_material_override only: exact material name copied from the target node's " +
        'materials list. Null when the node has only one material, or a prop (which always has ' +
        'a single material slot), or the instruction did not name one.',
    },
    baseColorHex: {
      type: 'STRING',
      nullable: true,
      description: 'set_material_override only: the new base colour, CSS hex e.g. #8B5A2B. Null when colour is unchanged.',
    },
    roughness: {
      type: 'NUMBER',
      nullable: true,
      description: 'set_material_override only: 0 (mirror-smooth) to 1 (fully diffuse). Null when unchanged.',
    },
    metalness: {
      type: 'NUMBER',
      nullable: true,
      description: 'set_material_override only: 0 (dielectric) to 1 (bare metal). Null when unchanged.',
    },
    finish: {
      type: 'STRING',
      nullable: true,
      description: 'set_material_override only: e.g. "matte", "polished". Null when unchanged.',
    },
    colorHex: {
      type: 'STRING',
      nullable: true,
      description:
        'set_light_property only: the new light colour, CSS hex - e.g. shift warmer/cooler in ' +
        'response to "warm up"/"cool down the lighting". Null when colour is unchanged.',
    },
    intensity: {
      type: 'NUMBER',
      nullable: true,
      description: 'set_light_property only: the new light intensity (absolute, not a delta). Null when unchanged.',
    },
    distance: {
      type: 'NUMBER',
      nullable: true,
      description: 'set_light_property only: the new falloff distance in metres (absolute). Null when unchanged.',
    },
    visible: {
      type: 'BOOLEAN',
      nullable: true,
      description: 'set_visibility only: true to show the node, false to hide it.',
    },
    propKind: {
      type: 'STRING',
      nullable: true,
      format: 'enum',
      enum: ['plinth', 'rug', 'partition', 'planter', 'side_table', 'floor_lamp'],
      description: 'add_prop only: which kind of simple staging prop to add.',
    },
    name: {
      type: 'STRING',
      nullable: true,
      description: "add_prop only: display name for the new prop. Null to use the prop kind's default label.",
    },
  },
  required: ['kind'],
} as const;

/** See `interpretSceneCommand` in lib/ai/gemini.ts (issue #60). */
export const SCENE_COMMAND_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mutations: {
      type: 'ARRAY',
      items: SCENE_MUTATION_SCHEMA,
      description:
        'Ordered list of concrete edits this command implies, using ONLY the supported ' +
        'mutation kinds. Empty array when nothing in the command maps to one.',
    },
    unresolved: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'Any distinct part of the command that could not be turned into a supported mutation - ' +
        'an unsupported kind of edit, or one naming a piece/material that is not listed - given ' +
        'in the operator\'s own words rather than guessed at. Empty when the whole command was understood.',
    },
  },
  required: ['mutations', 'unresolved'],
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
