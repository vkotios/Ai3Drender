/**
 * Geometric part segmentation - issue #57's candidate replacement for the
 * naming-convention matching `rebakePartMaterial` (lib/ai/mesh/rebake.ts)
 * currently relies on. That function matches a free-text target ("the
 * legs") against mesh node *names*, which only works on this app's own
 * massing/reconstruction output - a vendor-reconstructed mesh (Tripo,
 * Meshy, fal) never follows that convention, so nothing matches on those.
 *
 * A real segmentation model instead looks at the mesh's *geometry* and
 * returns which faces belong together, independent of how anything is
 * named. This port is deliberately narrow and, like `MeshProvider`
 * (lib/ai/mesh/types.ts), model-agnostic: swapping which segmentation
 * vendor or self-hosted model backs it must not touch callers.
 *
 * EVALUATION ONLY - nothing here is wired into the production Rebake flow
 * yet. Two candidates were built against this shared shape for comparison:
 *  - P3-SAM (lib/ai/segmentation/p3sam.ts): automatic whole-mesh
 *    segmentation via a hosted Space, but under a restrictive field-of-use
 *    license (see that file's own doc comment).
 *  - Point-SAM (lib/ai/segmentation/pointsam.ts): MIT licensed,
 *    point-prompted only - segments the single part that contains a given
 *    3D point, no whole-mesh automatic mode, and calls a self-hosted
 *    service rather than a public vendor endpoint.
 *
 * `PartSegmentationInput.promptPoint` and the P3-SAM-specific tuning knobs
 * (`postprocess`, `postprocessThreshold`, `seed`) all live on the one
 * shared input shape rather than per-provider option types, the same way
 * `promptPoint` is required by Point-SAM and simply ignored by P3-SAM: a
 * caller building one `PartSegmentationInput` should be able to hand it to
 * either provider without knowing which fields that particular one reads.
 */
import type { FurnitureSpec } from '@/lib/types';

export interface PartSegmentationInput {
  /**
   * Raw bytes of the mesh to segment, as binary glTF (.glb) - the same
   * format every `MeshProvider.reconstruct` (lib/ai/mesh/types.ts) returns,
   * so a provider's output can be fed into this port with no conversion.
   */
  meshGlb: Uint8Array;
  /**
   * Optional context for models that can use it (e.g. to bias sampling
   * toward the piece's known scale). Not required by either candidate.
   */
  spec?: FurnitureSpec;
  /**
   * The point to click, in the mesh's own local coordinate space (the same
   * frame the .glb's POSITION accessor uses - not normalised, not a pixel
   * coordinate). Required by a point-prompted model like Point-SAM; a
   * whole-mesh automatic model (P3-SAM) does not read it.
   *
   * TODO(#57 follow-up, not built yet): in the intended two-stage pipeline
   * this point comes from Gemini vision - a sibling to `resolvePartReference`
   * (lib/ai/gemini.ts) for *geometry* rather than names, which would render
   * the mesh from a known camera, ask Gemini to point at the target
   * description ("the legs") on that 2D image, and unproject the returned
   * pixel back onto the mesh surface using the same camera. That half does
   * not exist yet - this is where it plugs in. Until it does, callers must
   * supply `promptPoint` some other way (a raycast from a UI click, or a
   * fixture in an eval script).
   *
   * `label` follows SAM's own convention: 1 (default) is an inclusion click
   * ("the part is here"), 0 an exclusion click ("not this").
   */
  promptPoint?: { x: number; y: number; z: number; label?: 0 | 1 };
  /** P3-SAM only: merge small parts into their largest neighbour. Defaults to true. Ignored by a point-prompted provider. */
  postprocess?: boolean;
  /** P3-SAM only: 0-1; smaller merges more aggressively. Defaults to 0.95. Ignored by a point-prompted provider. */
  postprocessThreshold?: number;
  /** P3-SAM only: defaults to 42. Ignored by a point-prompted provider. */
  seed?: number;
  onProgress?: (progress: number, message: string) => void | Promise<void>;
}

/** One detected part: an id unique within this call and the faces that belong to it. */
export interface PartSegment {
  /** Stable within one `segmentParts` call only - not stable across runs or providers. */
  id: string;
  /**
   * 0-based indices into the segmented mesh's flattened triangle list (index
   * buffer position / 3), in traversal order across
   * `document.getRoot().listScenes()` - i.e. primitive 0's triangles first,
   * then primitive 1's, and so on. Meaningful against `segmentedGlb` when
   * the result carries one, otherwise against the input `meshGlb`
   * unchanged - see `PartSegmentationResult.segmentedGlb`.
   */
  faceIndices: number[];
  /** The model's own confidence for this segment, 0-1, when it reports one; null otherwise (e.g. P3-SAM). */
  score: number | null;
}

export interface PartSegmentationResult {
  /** Every detected part. */
  segments: PartSegment[];
  /**
   * Faces the model left unassigned to any part (a background/ambiguous
   * label some providers emit, e.g. P3-SAM's `-1`). Indices into the same
   * mesh as `segments[].faceIndices`. Empty for a provider that always
   * assigns every face, or that only ever returns the single segment a
   * prompt point landed in (Point-SAM).
   */
  unassignedFaceIndices: number[];
  /**
   * The mesh `segments[].faceIndices` are meaningful against, when a
   * provider returns one alongside the labels because it cleaned,
   * re-triangulated, or merged vertices before segmenting (P3-SAM does;
   * colour-coded per part when the provider does that itself, for visual
   * inspection). `undefined` means face indices are meaningful against the
   * input `meshGlb` unchanged (Point-SAM never re-triangulates - it samples
   * points from, and propagates labels back onto, the mesh as given).
   */
  segmentedGlb: Uint8Array | undefined;
  /** Provider-side job/event identifier, kept for support and re-download. */
  providerJobId: string | null;
}

/**
 * A geometric 3D part-segmentation vendor or self-hosted model.
 *
 * Swapping candidates (P3-SAM, Point-SAM, a future one) must not require
 * touching anything outside this directory - same discipline as
 * `MeshProvider`.
 */
export interface PartSegmentationProvider {
  readonly name: string;
  /** False when required configuration is missing, so callers can fail loudly. */
  readonly configured: boolean;
  segmentParts(input: PartSegmentationInput): Promise<PartSegmentationResult>;
}

export class PartSegmentationProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${provider}: ${message}`, options);
    this.name = 'PartSegmentationProviderError';
  }
}
