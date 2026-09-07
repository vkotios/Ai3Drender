/**
 * Geometric part-segmentation port (evaluation only - see lib/ai/segmentation/p3sam.ts).
 *
 * `rebakePartMaterial` (lib/ai/mesh/rebake.ts, issue #57) and `resolveComponent`
 * (lib/scene/anchor.ts) resolve a free-text target to a *named* mesh node,
 * which only works when the mesh's own node names happen to follow this app's
 * naming convention - true for `buildMassing`'s stub output, false for most
 * vendor-reconstructed meshes (Tripo/Meshy/fal), whose nodes are anonymous or
 * merged into one blob. A real part-segmentation model sidesteps naming
 * entirely by finding parts from geometry, at the cost of returning faces
 * rather than a name.
 *
 * This port is deliberately narrow, mirroring `MeshProvider`
 * (lib/ai/mesh/types.ts) so a second candidate (e.g. Point-SAM, evaluated on
 * a sibling branch) can implement it side by side for comparison. Nothing in
 * `lib/pipeline` or `lib/ai/mesh/rebake.ts` calls this yet - wiring a chosen
 * provider into the rebake path is a follow-up decision, not part of this
 * evaluation.
 */

export interface PartSegmentationOptions {
  /** Merge small parts into their largest neighbour. Defaults to true. */
  postprocess?: boolean;
  /** 0-1; smaller merges more aggressively. Defaults to 0.95. */
  postprocessThreshold?: number;
  /** Defaults to 42. */
  seed?: number;
}

/** One detected part: a stable-for-this-run id and the faces that belong to it. */
export interface PartSegment {
  /** Non-negative integer id, unique within one `segmentParts` call only - not stable across runs or providers. */
  id: number;
  /**
   * 0-based indices into the *segmented* mesh's triangle list (`segmentedGlb`
   * below), NOT necessarily the input `glb`'s. See `PartSegmentationResult`.
   */
  faceIndices: number[];
  faceCount: number;
}

export interface PartSegmentationResult {
  /** Every detected part, ordered by id. */
  segments: PartSegment[];
  /**
   * Faces the model left unassigned to any part (a background/ambiguous
   * label some providers emit, e.g. P3-SAM's `-1`). Indices into the same
   * mesh as `segments[].faceIndices`.
   */
  unassignedFaceIndices: number[];
  /** `segments[].faceCount` summed with `unassignedFaceIndices.length`. */
  totalFaceCount: number;
  /**
   * The mesh the provider actually labelled, returned alongside the labels
   * because a provider may clean, re-triangulate or merge vertices before
   * segmenting - so face indices are only meaningful against THIS mesh, not
   * necessarily byte-identical to the input `glb`. Colour-coded per part when
   * the provider does that itself (P3-SAM does, for visual inspection).
   */
  segmentedGlb: Uint8Array;
  /** Provider-side job/event identifier, kept for support and re-download. */
  providerJobId: string | null;
}

/**
 * A geometric 3D part-segmentation vendor or self-hosted model.
 *
 * Swapping candidates (P3-SAM, Point-SAM, a future self-hosted model) must
 * not require touching anything outside this directory - same discipline as
 * `MeshProvider`.
 */
export interface PartSegmentationProvider {
  readonly name: string;
  /** False when required configuration is missing, so callers can fail loudly. */
  readonly configured: boolean;
  segmentParts(glb: Uint8Array, options?: PartSegmentationOptions): Promise<PartSegmentationResult>;
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
