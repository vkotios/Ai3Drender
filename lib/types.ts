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
  /**
   * Set when this material is bound to a MaterialLibraryEntry - either because
   * the vision pass matched it against the account's known materials, or
   * because a human rebound it afterwards. While bound, every PBR field above
   * is kept in sync with the library entry's canonical values, so every piece
   * bound to the same entry renders identically instead of each drifting
   * slightly on its own. Null (or absent, on specs recorded before this field
   * existed) for an ad hoc, per-version material with no library counterpart.
   */
  libraryEntryId?: string | null;
  /**
   * True when the vision pass had library candidates to check against but
   * found no match, so it invented this material fresh. Surfaced in the UI so
   * a human can review it and, optionally, promote it into the library.
   * Always false once libraryEntryId is set. Optional/absent on specs
   * recorded before this field existed - treated the same as false.
   */
  invented?: boolean;
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
/* Shared material library                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One real material a manufacturer actually uses - a named timber, fabric,
 * powder-coat colour or finish, with fixed PBR values - kept apart from any
 * single piece so the same oak reads identically on every product it appears
 * on.
 *
 * Scoped by `ownerId` (account-level) rather than by project: a manufacturer's
 * range of finishes does not reset with every new exhibition stand, and
 * project-scoping would fragment one catalogue across every project the same
 * account runs. See the PR description for the full rationale.
 */
export interface MaterialLibraryEntry {
  id: Uuid;
  ownerId: string;
  name: string;
  /** Manufacturer SKU or internal code, e.g. "OAK-014". Null when there isn't one. */
  code: string | null;
  kind: MaterialKind;
  baseColorHex: string;
  roughness: number;
  metalness: number;
  sheen: number;
  clearcoat: number;
  finish: string;
  notes: string;
  /** Storage key of a reference swatch photo, resolved via store.blobUrl. */
  swatchPath: string | null;
  /**
   * Set when the material is discontinued. Kept rather than deleted so past
   * bindings and usage history stay traceable - the point of tracking usage at
   * all is to see what a discontinued fabric affects.
   */
  archivedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
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
 * What a `rebake_part` job changed (issue #57): re-bakes ONE named part's
 * material/texture directly into a new asset version's mesh, permanently -
 * distinct from `MaterialSpec`'s spot-fix (issue #48, which only patches the
 * spec's descriptive PBR values) and from `SceneNode.materialOverrides`
 * (issue #7, a viewer-side override that never touches the stored mesh).
 *
 * Kept on the version for the same reason `refinement` is: so the version
 * history is self-describing. Absent (or null) on every version not produced
 * this way, including everything recorded before this field existed - treated
 * the same as no rebake.
 */
export interface RebakePartRequest {
  /** How the target part was addressed - an exact component/node name, or free text. */
  target: string;
  /** The spec component(s) `target` resolved to and whose `materialId` this rebake repointed. */
  componentNames: string[];
  /** Mesh node/primitive names in the new .glb that were actually repainted. */
  meshPartNames: string[];
  /** How the new material was sourced. */
  materialSource: 'library' | 'instruction';
  /** Library entry bound, when `materialSource === 'library'`. */
  libraryEntryId: string | null;
  /** Free-text correction, when `materialSource === 'instruction'`. */
  instruction: string | null;
  /** `materials[].id` (in the new version's spec) now bound to the rebaked part. */
  materialId: string;
}

/**
 * Perceptual QA verdict for a reconstructed mesh: does it actually look like
 * the source photographs it was built from? A vision-model opinion, not a
 * structural check (gltf-transform's round-trip already covers that) - so
 * this is always a soft warning surfaced in the UI, never a blocker on
 * accepting or using the version. See lib/ai/gemini.ts's `evaluateReconstruction`.
 */
export interface QaResult {
  /** 0 (no resemblance to the photos) to 100 (matches them closely). */
  score: number;
  /** Specific mismatches (missing part, wrong proportions, wrong material/colour). Empty when none were found. */
  issues: string[];
  /** Whether a real vision model produced this, or it is the offline placeholder. */
  source: 'gemini' | 'offline';
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
  /** Storage key of the full-detail .glb. Null while reconstruction is still running. */
  meshPath: string | null;
  /**
   * Storage key of a decimated copy of `meshPath`, generated once at
   * `reconstruct` time via `@gltf-transform/functions`'s `simplify` (see
   * `lib/ai/mesh/simplify.ts`). Serves the real-time studio viewport (and, by
   * extension, the in-browser path tracer, which renders the same live
   * scene) so orbiting a dense vendor mesh stays responsive.
   *
   * Null when reconstruction hasn't produced a mesh yet, or when
   * simplification failed or would not have reduced the mesh at all - the
   * viewport falls back to `meshPath` in that case (see
   * `components/studio/AssetNode.tsx`). The Blender render worker and
   * glTF/OBJ export always use `meshPath`, never this field.
   */
  previewMeshPath: string | null;
  /** Longest-axis size of the raw mesh, used to scale it to real-world mm. */
  meshExtentMm: number | null;
  /** Storage key of a small captured PNG of the mesh, for list thumbnails. Null until one is captured. */
  previewPath: string | null;
  provider: string;
  providerJobId: string | null;
  refinement: RefinementRequest | null;
  /** Set when a `rebake_part` job produced this version. See `RebakePartRequest`. */
  rebakedPart?: RebakePartRequest | null;
  /**
   * Perceptual fidelity check against the source photos, run once after the
   * mesh is built. Null until it runs (or if it failed - see reconstruct's
   * try/catch in lib/pipeline/index.ts) - callers must treat null as "no
   * opinion yet", not as a passing score.
   */
  qaResult: QaResult | null;
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
  /**
   * Per-node material tweaks that do not fork the underlying asset version.
   *
   * Keyed by `MaterialSpec.id` (stable across a refinement even when the
   * material's display name changes), except for a prop node's single entry
   * which lives under the literal key `"prop"`. A key that matches neither a
   * live id nor the mesh's own material name (a vendor mesh with names we do
   * not control) is left in place rather than silently dropped - see
   * `lib/scene/materialOverrides.ts`.
   */
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

/**
 * Where a client's review of a shared scene stands.
 *
 * Set only through the read-only share view (`/share/[token]`) - the owner
 * never sets this directly, it is what the client told them.
 *
 * Five states, modelled after Ziflow's per-reviewer verdict (see
 * `docs/competitive-gap-analysis.md` §05, issue #41):
 *   - `pending` - the default; no verdict submitted yet.
 *   - `approved` - signed off outright.
 *   - `approved_with_changes` - signed off, but see the note/notes - the
 *     workshop can proceed without waiting on a second round.
 *   - `changes_requested` - blocking; the stand needs rework before sign-off.
 *   - `not_relevant` - this scene is not this client's to review (e.g. an
 *     internal-only variant, or a stand superseded by another share link).
 *
 * This stays a single field on `Scene` rather than a per-annotation reviewer
 * verdict: approval here is a sign-off on the whole staged stand, not on any
 * one note, and every annotation already carries its own independent
 * `AnnotationStatus` lifecycle (open/applied/dismissed). Layering a second,
 * parallel verdict onto each annotation would answer a question nobody asked
 * ("did the client fully review file X" - Ziflow's design point, for a
 * multi-asset review queue) while this app reviews one exhibition stand at a
 * time. Five values on this existing field expresses everything the issue
 * asks for without that extra structure - see the PR description for the
 * full reasoning.
 */
export type ClientApproval =
  | 'pending'
  | 'approved'
  | 'approved_with_changes'
  | 'changes_requested'
  | 'not_relevant';

export interface Scene {
  id: Uuid;
  projectId: Uuid;
  name: string;
  doc: SceneDoc;
  /** Art direction produced by Gemini for this scene, kept for traceability. */
  direction: SceneDirection | null;
  acceptedAt: IsoDate | null;
  /** "Client signed off on this stand" - set from the share view, read here. */
  clientApproval: ClientApproval;
  clientApprovalAt: IsoDate | null;
  /** The name the client typed into the share view when they set the verdict. */
  clientApprovalName: string | null;
  /** Free-text reason, mainly useful when changes were requested. */
  clientApprovalNote: string | null;
  /**
   * Bumped every time `doc` is saved. The studio round-trips whatever value
   * it loaded back with the next save so the server can tell a stale write
   * from a fresh one - see `Store.updateScene` and `SceneConflictError`.
   */
  version: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/** One retained save of a scene's `doc`, going back to its creation. */
export interface SceneVersion {
  id: Uuid;
  sceneId: Uuid;
  versionNumber: number;
  doc: SceneDoc;
  note: string;
  createdAt: IsoDate;
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
  | 'render'
  | 'rebake_part';

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
 * 'point' anchors a note to one clicked spot; 'part' covers every numbered
 * instance of a named part at once (e.g. all four `Legs`), taken as a unit;
 * 'freehand' anchors a drawn stroke across the surface - a line, a circled
 * region, an "along this whole edge" gesture - richer than either (issue #63).
 */
export type SelectionKind = 'point' | 'part' | 'freehand';

/**
 * One sample along a freehand stroke, anchored exactly like a 'point'
 * selection is: a local-space position plus whatever mesh part the raycast
 * hit at that spot. No new anchoring scheme - just an ordered list of the
 * same point anchor every other selection kind already uses, which is what
 * lets the stroke be redrawn along the same silhouette regardless of camera
 * angle or (within reason) a later mesh revision.
 */
export interface StrokePoint {
  point: Vec3;
  /** Mesh part this sample landed on, or null off any named part. Raw mesh name (e.g. "Legs 3"), not base-named. */
  partName: string | null;
}

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
/**
 * Who pinned a note.
 *
 * 'internal' notes come from an authenticated studio user; 'client' notes
 * come through a scene share link, from someone with no account at all. Kept
 * distinct so the review panel can badge them and the model prompt can weigh
 * them differently if that ever matters.
 */
export type AnnotationSource = 'internal' | 'client';

export interface Annotation {
  id: Uuid;
  assetId: Uuid;
  /**
   * The version this note is currently pinned to. For a fresh note this is
   * the version it was made against; a note still `open` when its version is
   * superseded is re-pointed here at the newest version instead of going
   * stale on the old one (see `refine` in lib/pipeline/index.ts).
   */
  assetVersionId: Uuid;
  /**
   * The version this note was originally pinned on. Set once at creation and
   * never touched again, so a note carried forward across several rounds can
   * still read "since v1" even though `assetVersionId` has long since moved
   * on. Paired with `originVersionNumber` so the UI can show that without an
   * extra lookup for a version that may no longer be loaded.
   */
  originVersionId: Uuid;
  originVersionNumber: number;
  /** Scene the note was taken in, for traceability. Null if made elsewhere. */
  sceneId: Uuid | null;
  /**
   * 'point' pins one clicked spot; 'part' covers every numbered instance of
   * the named part at once (e.g. all four `Legs`), taken as a single unit.
   */
  selectionKind: SelectionKind;
  /**
   * Anchor in the asset's local space, metres. For a 'part' selection this is
   * the centroid of every matching instance, not a spot the user picked - it
   * exists to place the marker, not to describe the note's location.
   */
  point: Vec3;
  /** Surface normal at the anchor, for orienting the marker. */
  normal: Vec3;
  /**
   * Ordered samples along a freehand stroke - present only when
   * `selectionKind` is 'freehand', null for every other kind. `point` above
   * is the stroke's centroid (marker placement only, the same convention a
   * 'part' selection's centroid already uses - it exists to place the pin,
   * not to describe the note's location) and `partName`/`componentName`/
   * `componentRole` below name only the first part the stroke touched;
   * `formatAnnotationForPrompt` walks every sample here to name every part
   * the stroke actually crosses, since a drawn line rarely stays on one.
   */
  strokePoints: StrokePoint[] | null;
  /**
   * Mesh part under the cursor, e.g. "Legs 3", or the base part name ("Legs")
   * for a whole-part selection, or the first part a freehand stroke touched.
   * Null on unnamed vendor meshes.
   */
  partName: string | null;
  /** Spec component the part maps to, when it can be resolved. */
  componentName: string | null;
  componentRole: string | null;
  /**
   * Where the note applies, in plain language - either a position, e.g.
   * "front-left, 180 mm above the floor", or, for a whole-part selection,
   * "as a whole, all 4 instances". Always derivable, so the model is never
   * left without location.
   */
  anchorDescription: string;
  body: string;
  status: AnnotationStatus;
  source: AnnotationSource;
  /** Free-text name typed into the share view. Null for internal notes. */
  clientName: string | null;
  /** The version created in response to this note. */
  resolvedByVersionId: Uuid | null;
  /**
   * Set only when this note was carried forward to a newer version and its
   * anchor could not be cleanly reconciled with that version's spec - either
   * the part it named no longer resolves to a component (renamed, merged or
   * removed), or the anchor point now falls outside the piece's bounding box.
   * Null otherwise, including for notes that have never been carried
   * forward. The pin itself, its position and its `open` status are left
   * alone; this is only a heads-up that its context may be stale.
   */
  staleNote: string | null;
  /**
   * Set when this note is a reply to another annotation rather than its own
   * pin. Reuses this same table rather than a separate `annotation_replies`
   * one: a reply needs the exact same shape (body, source/clientName,
   * mentions) as a top-level note, and every other field it would otherwise
   * duplicate (point, normal, partName, componentName/Role,
   * anchorDescription, assetVersionId, originVersionId/Number, sceneId) is
   * simply inherited from the parent at creation time - see the annotations
   * route. Kept one level deep (a reply's own `parentAnnotationId`, if this
   * were allowed to nest, is rejected by the API) since the panel threads a
   * note and its replies, not an arbitrary tree.
   *
   * A reply is not itself carried forward across a version revision (see
   * `carryForwardOpenAnnotations`) and is not sent to the model as its own
   * revision note - only its parent is. It is, however, deleted along with
   * its parent (cascades in Postgres; mirrored in `LocalStore`).
   */
  parentAnnotationId: Uuid | null;
  /**
   * Names captured from `@name` tokens in `body`, in first-appearance order.
   * UI-only for now: rendering an `@mention` distinctly in the panel and
   * recording who was named. Actually notifying that person is out of scope
   * here - tracked separately (issue #46).
   */
  mentions: string[];
  createdAt: IsoDate;
}

/* -------------------------------------------------------------------------- */
/* Client review share links                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A tokenized, read-only grant onto one scene.
 *
 * This is deliberately shaped as a grant on a resource rather than as
 * something link-specific: `resourceType`/`resourceId` name what is shared,
 * `granteeToken` (hashed, never stored in clear) names who holds it. A future
 * team-access feature can reuse the same shape with a `granteeUserId` instead
 * of a token and a broader role, without redesigning this table. See the
 * migration and PR description for the full reasoning.
 */
export type ShareRole = 'viewer' | 'commenter';

export interface SceneShareLink {
  id: Uuid;
  sceneId: Uuid;
  /** Viewer id of whoever generated the link. */
  createdBy: string;
  /** Always 'commenter' today - clients can pin notes and set approval. */
  role: ShareRole;
  /** Optional owner-set label, e.g. "Acme Corp - first pass". */
  label: string | null;
  expiresAt: IsoDate | null;
  revokedAt: IsoDate | null;
  lastAccessedAt: IsoDate | null;
  /** Set when the reminder sweep last emailed the owner about this link. See `Store.markShareLinkReminded`. */
  lastReminderSentAt: IsoDate | null;
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
