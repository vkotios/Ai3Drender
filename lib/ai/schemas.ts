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

/**
 * One categorized defect (issue #56). `category` is a small closed enum -
 * see `MeshDefectCategory` in lib/types.ts for what each value means - rather
 * than free text, so the model reliably picks from a fixed rubric instead of
 * inventing its own wording for the same handful of failure modes.
 */
const meshDefect = {
  type: 'OBJECT',
  properties: {
    category: {
      type: 'STRING',
      format: 'enum',
      enum: [
        'fused_parts',
        'incomplete_part',
        'missing_geometry',
        'extra_geometry',
        'form_defect',
        'surface_defect',
        'texture_defect',
      ],
      description:
        'fused_parts = distinct parts read as one merged blob; incomplete_part = a part is ' +
        'present but truncated/thin/not fully formed; missing_geometry = a part or feature the ' +
        'photos show is entirely absent; extra_geometry = geometry present that should not be ' +
        '(duplicated part, floating artifact); form_defect = overall silhouette/proportions read ' +
        'wrong though every part is present; surface_defect = local surface noise/warping/holes ' +
        'on an otherwise correct part; texture_defect = geometry is right but colour/material/ ' +
        'finish reads wrong.',
    },
    description: {
      type: 'STRING',
      description:
        'One concrete sentence, e.g. "the left armrest is fused into the backrest with no seam".',
    },
    severity: {
      type: 'STRING',
      format: 'enum',
      enum: ['minor', 'moderate', 'severe'],
      description: 'How much this defect would matter to a buyer looking closely at the piece.',
    },
    componentName: {
      type: 'STRING',
      nullable: true,
      description:
        'The exact name of the affected component, copied verbatim from the "Named components" ' +
        'list, when this defect is localized to one specific part. Null when it affects the ' +
        'whole piece or spans several parts equally (e.g. an overall proportion issue), or when ' +
        'no named component list was supplied.',
    },
  },
  required: ['category', 'description', 'severity', 'componentName'],
} as const;

export const QA_RESULT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: {
      type: 'NUMBER',
      description:
        '0 to 100 fidelity score: how closely the rendered mesh views match the source ' +
        'photographs in silhouette, proportions, materials and colour. 100 = indistinguishable ' +
        'from the photos; 0 = no resemblance at all. An overall summary - put the specifics in ' +
        'defects below.',
    },
    defects: {
      type: 'ARRAY',
      items: meshDefect,
      description:
        'Concrete, categorized mismatches between the mesh and the photos. Empty array when the ' +
        'mesh is a faithful match. Do not restate the score as a defect.',
    },
  },
  required: ['score', 'defects'],
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
        'add_light',
        'delete_node',
        'duplicate_node',
      ],
    },
    nodeName: {
      type: 'STRING',
      nullable: true,
      description:
        'The exact name of the staged node this mutation targets, copied verbatim from the ' +
        '"Staged nodes" list. Required for delete_node and duplicate_node. Null for add_prop and ' +
        'add_light (which create a new node instead of targeting one), or when no listed node ' +
        'plausibly matches - never invent a name.',
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
      description:
        "add_prop/add_light only: display name for the new node. Null to use the prop kind's " +
        'or light type\'s default label.',
    },
    lightType: {
      type: 'STRING',
      nullable: true,
      format: 'enum',
      enum: ['key', 'fill', 'rim', 'accent'],
      description: 'add_light only: which kind of light to add.',
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

/** A point on the floor-plan image itself, as a fraction of its width/height - see `FLOOR_PLAN_SCENE_SCHEMA`. */
const imageFraction = {
  type: 'OBJECT',
  properties: {
    u: { type: 'NUMBER', description: 'Fraction of the image width: 0 at the left edge, 1 at the right edge.' },
    v: { type: 'NUMBER', description: 'Fraction of the image height: 0 at the top edge, 1 at the bottom edge.' },
  },
  required: ['u', 'v'],
} as const;

/** See `generateSceneFromFloorPlan` in lib/ai/gemini.ts (issue #58). */
export const FLOOR_PLAN_SCENE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    boundary: {
      type: 'ARRAY',
      items: imageFraction,
      description:
        'Ordered polygon vertices tracing the outer boundary of the booth/room floor area shown ' +
        'in the plan (at least 3 points) - the wall line itself, not any furniture inside it.',
    },
    widthM: {
      type: 'NUMBER',
      nullable: true,
      description:
        'Real-world width, in metres, of the FULL image (left edge to right edge) - only when a ' +
        'printed scale bar, dimension line or room measurement in the plan makes this a reliable ' +
        'reading. Null when no such reference is visible; never guess from typical room sizes.',
    },
    placements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          assetName: {
            type: 'STRING',
            nullable: true,
            description:
              'Exact name of a candidate piece (from the "Available pieces" list) this placement ' +
              'stages, copied verbatim. Null when no listed piece plausibly matches this spot.',
          },
          propKind: {
            type: 'STRING',
            nullable: true,
            format: 'enum',
            enum: ['plinth', 'rug', 'partition', 'planter', 'side_table', 'floor_lamp'],
            description:
              'A generic staging prop to place here instead, only when assetName is null and the ' +
              'plan shows some simple furnishing (a rug, a low table, a planter...) with no listed ' +
              'piece to match it.',
          },
          name: {
            type: 'STRING',
            nullable: true,
            description: "Display label for this placement. Null to use the matched piece's or prop's own name.",
          },
          u: imageFraction.properties.u,
          v: imageFraction.properties.v,
          rotationDegrees: {
            type: 'NUMBER',
            nullable: true,
            description: 'Facing angle in degrees, 0 = facing the bottom edge of the image. Null defaults to 0.',
          },
        },
        required: ['u', 'v'],
      },
      description:
        'Where to stage furniture within the boundary - one entry per piece drawn or clearly ' +
        'implied by the plan. Empty when the plan shows an empty shell with nothing to place.',
    },
  },
  required: ['boundary', 'placements'],
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
