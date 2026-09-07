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
 * EVALUATION ONLY (see PR description) - nothing here is wired into the
 * production Rebake flow yet. Two candidate models are being compared in
 * parallel, on separate branches:
 *  - Point-SAM (this branch, `lib/ai/segmentation/pointsam.ts`): MIT
 *    licensed, point-prompted only - segments the single part that
 *    contains a given 3D point, no whole-mesh automatic mode.
 *  - P3-SAM (sibling branch): automatic whole-mesh segmentation, but under
 *    a restrictive field-of-use license.
 *
 * `PartSegmentationInput.promptPoint` exists on this shared shape only
 * because Point-SAM's contract requires it - an automatic model simply
 * ignores it. See the field's own doc comment for how that point is meant
 * to get chosen.
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
   * toward the piece's known scale). Not required for a Point-SAM call.
   */
  spec?: FurnitureSpec;
  /**
   * The point to click, in the mesh's own local coordinate space (the same
   * frame the .glb's POSITION accessor uses - not normalised, not a pixel
   * coordinate). Required by a point-prompted model like Point-SAM; a
   * whole-mesh automatic model (the sibling P3-SAM port) does not read it.
   *
   * TODO(#57 follow-up, not built in this task): in the intended two-stage
   * pipeline this point comes from Gemini vision - a sibling to
   * `resolvePartReference` (lib/ai/gemini.ts) for *geometry* rather than
   * names, which would render the mesh from a known camera, ask Gemini to
   * point at the target description ("the legs") on that 2D image, and
   * unproject the returned pixel back onto the mesh surface using the same
   * camera. That half does not exist yet - this is where it plugs in.
   * Until it does, callers must supply `promptPoint` some other way (a
   * raycast from a UI click, or a fixture in an eval script).
   *
   * `label` follows SAM's own convention: 1 (default) is an inclusion
   * click ("the part is here"), 0 an exclusion click ("not this").
   */
  promptPoint?: { x: number; y: number; z: number; label?: 0 | 1 };
  onProgress?: (progress: number, message: string) => void | Promise<void>;
}

export interface PartSegment {
  /** Stable within one segmentation call; not meaningful across calls. */
  id: string;
  /**
   * Triangle indices this segment covers, into the mesh's flattened
   * triangle list (index buffer position / 3) in traversal order across
   * `document.getRoot().listScenes()` - i.e. primitive 0's triangles first,
   * then primitive 1's, and so on. Concatenating every segment's
   * `faceIndices` and comparing against the mesh's total triangle count is
   * how a caller checks for coverage gaps or overlaps.
   */
  faceIndices: number[];
  /** The model's own confidence for this segment, 0-1, when it reports one. */
  score: number | null;
}

export interface PartSegmentationResult {
  segments: PartSegment[];
  /** Vendor/service-side job identifier, kept for support and debugging. */
  providerJobId: string | null;
}

/**
 * Geometric part-segmentation vendor.
 *
 * Same narrow-port shape as `MeshProvider`: swapping which model backs
 * this, including moving between a hosted vendor and a self-hosted one,
 * must not require touching a caller.
 */
export interface PartSegmentationProvider {
  readonly name: string;
  /** False when the service/API this provider needs isn't configured. */
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
