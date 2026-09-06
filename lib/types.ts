/**
 * Domain model for the furniture -> 3D asset pipeline.
 *
 * The flow this describes:
 *   photos -> FurnitureSpec (Gemini vision)
 *          -> synthesized orthographic views (Gemini image)
 *          -> .glb mesh (mesh reconstruction vendor)
 *          -> AssetVersion (versioned, refinable)
 *          -> SceneDoc (exhibition staging, also versioned)
 *          -> exported glTF / GLB / OBJ
 */

export type Uuid = string;
export type IsoDate = string;

/* -------------------------------------------------------------------------- */
/* Projects and intake                                                        */
/* -------------------------------------------------------------------------- */

export interface Project {
  id: Uuid;
  ownerId: string;
  name: string;
  client: string | null;
  /** Free-text art direction that seeds every scene in the project. */
  brief: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** How a source photo is meant to be used by the reconstruction stage. */
export type SourceImageRole =
  /** Best full view of the piece. Drives silhouette and proportion. */
  | 'primary'
  /** Close-ups: joinery, stitching, grain. Drives material inference. */
  | 'detail'
  /** Additional angles of the same piece. Improves reconstruction fidelity. */
  | 'alternate'
  /** Mood/styling references. Never reconstructed, only used for art direction. */
  | 'mood';

export interface SourceImage {
  id: Uuid;
  projectId: Uuid;
  /** Storage key, resolved to a URL by the storage adapter. */
  path: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  role: SourceImageRole;
  createdAt: IsoDate;
}

/* -------------------------------------------------------------------------- */
/* What Gemini extracts from the photos                                       */
/* -------------------------------------------------------------------------- */

export type MaterialKind =
  | 'wood'
  | 'metal'
  | 'fabric'
  | 'leather'
  | 'glass'
  | 'stone'
  | 'plastic'
  | 'composite';

/**
 * A physically-based material description. Maps 1:1 onto a three.js
 * MeshPhysicalMaterial and onto glTF's pbrMetallicRoughness on export.
 */
export interface MaterialSpec {
  id: string;
  name: string;
  kind: MaterialKind;
  baseColorHex: string;
  /** 0 = mirror, 1 = fully diffuse. */
  roughness: number;
  /** 0 = dielectric, 1 = raw metal. Values in between are rarely physical. */
  metalness: number;
  /** Fabric/velvet rim response. Ignored for hard materials. */
  sheen: number;
  /** Lacquer or varnish layer over the base, e.g. polished wood. */
  clearcoat: number;
  /** Human-readable finish, e.g. "brushed", "oiled walnut", "powder-coated". */
  finish: string;
  notes: string;
}

/** A named sub-part of the piece, used to drive per-part material assignment. */
export interface FurnitureComponent {
  name: string;
  /** e.g. "seat", "backrest", "leg", "armrest", "frame", "cushion". */
  role: string;
  materialId: string;
  approxSizeMm: Dimensions3;
}

export interface Dimensions3 {
  widthMm: number;
  depthMm: number;
  heightMm: number;
}

export type ConfidenceLevel = 'stated' | 'estimated' | 'rough';

/**
 * The structured understanding of one furniture piece. This is the contract
 * between the vision layer and everything downstream - reconstruction prompts,
 * real-world scaling, material assignment and scene staging all read from it.
 */
export interface FurnitureSpec {
  displayName: string;
  category: string;
  summary: string;
  dimensions: Dimensions3;
  /** Chairs and sofas need this to sit correctly against tables in a scene. */
  seatHeightMm: number | null;
  dimensionConfidence: ConfidenceLevel;
  components: FurnitureComponent[];
  materials: MaterialSpec[];
  /** Dominant colours as hex, ordered by visual weight. */
  palette: string[];
  styleTags: string[];
  symmetry: 'bilateral' | 'radial' | 'none';
  /** Guidance passed verbatim into the mesh vendor's prompt. */
  reconstructionNotes: string;
}

/* -------------------------------------------------------------------------- */
/* Assets and their versions                                                  */
/* -------------------------------------------------------------------------- */

export type AssetStatus =
  | 'draft'
  | 'analyzing'
  | 'generating_views'
  | 'reconstructing'
  | 'ready'
  | 'failed';

export interface FurnitureAsset {
  id: Uuid;
  projectId: Uuid;
  name: string;
  status: AssetStatus;
  /** Null until the first version finishes reconstructing. */
  currentVersionId: Uuid | null;
  sourceImageIds: Uuid[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** A synthesized camera view used as reconstruction input. */
export interface SynthesizedView {
  /** Canonical camera name, e.g. "front", "three_quarter_left". */
  angle: string;
  path: string;
  /** True when the image came from the user rather than the image model. */
  fromSource: boolean;
}

/**
 * What the user asked to change when spinning a new version off an existing
 * one. Kept on the version so the refinement history is self-describing.
 */
export interface RefinementRequest {
  instruction: string;
  /** Anchored notes this refinement is answering, resolved at enqueue time. */
  annotationIds?: Uuid[];
  /** Targeted overrides applied without re-running reconstruction. */
  specOverrides?: Partial<Pick<FurnitureSpec, 'dimensions' | 'materials' | 'displayName'>>;
  /** When true the mesh is rebuilt; otherwise only the spec/materials change. */
  rebuildMesh: boolean;
}

/**
 * An immutable snapshot of one furniture asset. "Modify and refine" always
 * creates a new version rather than mutating an accepted one, so an approved
 * render can never be silently changed underneath a customer.
 */
export interface AssetVersion {
  id: Uuid;
  assetId: Uuid;
  versionNumber: number;
  label: string;
  parentVersionId: Uuid | null;
  spec: FurnitureSpec;
  views: SynthesizedView[];
  /** Storage key of the .glb. Null while reconstruction is still running. */
  meshPath: string | null;
  /** Longest-axis size of the raw mesh, used to scale it to real-world mm. */
  meshExtentMm: number | null;
  provider: string;
  providerJobId: string | null;
  refinement: RefinementRequest | null;
  /** Set once a human signs the version off. Accepted versions are read-only. */
  acceptedAt: IsoDate | null;
  createdAt: IsoDate;
}

/* -------------------------------------------------------------------------- */
/* Exhibition scenes                                                          */
/* -------------------------------------------------------------------------- */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Transform {
  position: Vec3;
  /** Euler angles in radians, XYZ order. */
  rotation: Vec3;
  scale: Vec3;
}

export type SceneNodeKind = 'asset' | 'prop' | 'light';

/** Simple staging geometry that does not need reconstruction. */
export type PropKind =
  | 'plinth'
  | 'rug'
  | 'partition'
  | 'planter'
  | 'side_table'
  | 'floor_lamp';

export interface SceneNode {
  id: string;
  name: string;
  kind: SceneNodeKind;
  transform: Transform;
  visible: boolean;
  /** Set when kind === 'asset'. Points at an immutable AssetVersion. */
  assetVersionId: Uuid | null;
  /** Set when kind === 'prop'. */
  propKind: PropKind | null;
  /** Set when kind === 'light'. */
  light: SceneLight | null;
  /** Per-node material tweaks that do not fork the underlying asset version. */
  materialOverrides: Record<string, Partial<MaterialSpec>>;
}

export interface SceneLight {
  type: 'key' | 'fill' | 'rim' | 'accent';
  colorHex: string;
  intensity: number;
  /** Metres. Ignored for directional-style key lights. */
  distance: number;
}

export interface EnvironmentSettings {
  presetId: string;
  floorMaterialId: string;
  floorColorHex: string;
  wallColorHex: string;
  /** Metres. Booth footprint. */
  boothWidth: number;
  boothDepth: number;
  boothHeight: number;
  /** Which of the four walls are built. Open sides read as aisles. */
  walls: { back: boolean; left: boolean; right: boolean };
  /** drei environment preset name driving image-based lighting. */
  hdriPreset: string;
  hdriIntensity: number;
  ambientIntensity: number;
  backgroundColorHex: string;
  showGrid: boolean;
}

export interface CameraSettings {
  position: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees. 35mm-equivalent framing sits near 40. */
  fov: number;
}

export interface SceneDoc {
  schemaVersion: 1;
  environment: EnvironmentSettings;
  camera: CameraSettings;
  nodes: SceneNode[];
}

export interface Scene {
  id: Uuid;
  projectId: Uuid;
  name: string;
  doc: SceneDoc;
  /** Art direction produced by Gemini for this scene, kept for traceability. */
  direction: SceneDirection | null;
  acceptedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** Gemini's art-direction pass over a booth brief. */
export interface SceneDirection {
  concept: string;
  rationale: string;
  paletteHex: string[];
  lightingNotes: string;
  suggestedProps: PropKind[];
}

/* -------------------------------------------------------------------------- */
/* Pipeline jobs                                                              */
/* -------------------------------------------------------------------------- */

export type JobKind =
  | 'analyze'
  | 'synthesize_views'
  | 'reconstruct'
  | 'refine'
  | 'direct_scene'
  | 'concept_render'
  | 'render';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job {
  id: Uuid;
  projectId: Uuid;
  assetId: Uuid | null;
  kind: JobKind;
  status: JobStatus;
  /** 0..1, advanced by the stage as it works. */
  progress: number;
  /** Human-readable current step, surfaced in the UI. */
  message: string;
  error: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  /** Completed tries, including the one in flight. */
  attempts: number;
  /** Tries allowed before a retryable failure becomes permanent. */
  maxAttempts: number;
  /**
   * When the current claim lapses.
   *
   * A worker that dies mid-job cannot release its own claim, so the row would
   * otherwise sit in `running` forever. Whoever drains the queue next reclaims
   * anything past this and puts it back in the queue.
   */
  leaseExpiresAt: IsoDate | null;
  /**
   * Earliest time this job may be claimed. Set when a retry is scheduled, so
   * a failing vendor is backed off rather than hammered.
   */
  nextAttemptAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/* -------------------------------------------------------------------------- */
/* Anchored annotations                                                       */
/* -------------------------------------------------------------------------- */

export type AnnotationStatus = 'open' | 'applied' | 'dismissed';

/**
 * A note pinned to a point on a piece's geometry.
 *
 * This is the review loop a workshop actually runs on: someone points at the
 * thing and says what is wrong with it. Anchoring the note to geometry rather
 * than leaving it as free text is what lets the model act on it precisely -
 * "slim this down" is useless, "slim the front-left leg, 180mm above the
 * floor, currently 70mm square" is actionable.
 *
 * The anchor is stored in the ASSET's local space, not world space, so a note
 * survives the piece being moved, rotated or restaged in another booth.
 */
export interface Annotation {
  id: Uuid;
  assetId: Uuid;
  /** The version the note was made against. */
  assetVersionId: Uuid;
  /** Scene the note was taken in, for traceability. Null if made elsewhere. */
  sceneId: Uuid | null;
  /** Anchor in the asset's local space, metres. */
  point: Vec3;
  /** Surface normal at the anchor, for orienting the marker. */
  normal: Vec3;
  /** Mesh part under the cursor, e.g. "Legs 3". Null on unnamed vendor meshes. */
  partName: string | null;
  /** Spec component the part maps to, when it can be resolved. */
  componentName: string | null;
  componentRole: string | null;
  /**
   * Where the note sits on the piece in plain language, e.g.
   * "front-left, 180 mm above the floor". Always derivable, even when the
   * mesh carries no part names, so the model is never left without location.
   */
  anchorDescription: string;
  body: string;
  status: AnnotationStatus;
  /** The version created in response to this note. */
  resolvedByVersionId: Uuid | null;
  createdAt: IsoDate;
}

/* -------------------------------------------------------------------------- */
/* Rendered output                                                            */
/* -------------------------------------------------------------------------- */

export type SceneRenderKind =
  /** Progressively path-traced in the browser. Geometrically faithful. */
  | 'pathtraced'
  /** Image-model pass over a viewport capture. Fast, NOT spec-accurate. */
  | 'concept'
  /** Offline Blender/Cycles render. Geometrically faithful, print resolution. */
  | 'render';

export interface SceneRender {
  id: Uuid;
  sceneId: Uuid;
  projectId: Uuid;
  kind: SceneRenderKind;
  path: string;
  width: number;
  height: number;
  /** Samples accumulated, for path-traced renders and offline Cycles renders. */
  samples: number | null;
  /** The instruction given to the image model, for concept renders. */
  prompt: string | null;
  createdAt: IsoDate;
}

/** Extra render passes an offline render job may produce alongside the beauty pass. */
export type RenderPass = 'ao' | 'cryptomatte';

/** What the studio can ask the offline render worker for. */
export interface OfflineRenderRequest {
  sceneId: Uuid;
  width: number;
  height: number;
  /** Cycles samples. Higher is cleaner and slower. */
  samples?: number;
  /** On by default - the whole point of an offline pass is a clean image. */
  denoise?: boolean;
  /** Advanced option: extra passes written alongside the beauty image. */
  passes?: RenderPass[];
  format?: 'png' | 'exr';
}
