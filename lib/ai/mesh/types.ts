import type { FurnitureSpec } from '@/lib/types';

export interface ReconstructionInput {
  spec: FurnitureSpec;
  /**
   * Publicly reachable image URLs, best view first. Vendors fetch these
   * themselves, so they must be absolute and readable without our cookies.
   */
  imageUrls: string[];
  /** Raw bytes of the same images, for vendors that accept direct upload. */
  images: { bytes: Uint8Array; mimeType: string }[];
  /** Free-text guidance appended to the vendor prompt. */
  notes: string;
  onProgress?: (progress: number, message: string) => void | Promise<void>;
}

export interface ReconstructionResult {
  /** The finished binary glTF. */
  glb: Uint8Array;
  /** Vendor-side job identifier, kept for support and re-download. */
  providerJobId: string | null;
  /**
   * Longest-axis extent of the returned mesh in millimetres, when the vendor
   * reports real-world scale. Null means the mesh is unit-scaled and the
   * pipeline must normalise it against the spec dimensions.
   */
  extentMm: number | null;
}

/**
 * Photo-to-3D reconstruction vendor.
 *
 * Deliberately a narrow port: swapping vendors, or moving to a self-hosted
 * model, must not require touching the pipeline or the UI.
 */
export interface MeshProvider {
  readonly name: string;
  /** False when the required API key is missing, so callers can fail loudly. */
  readonly configured: boolean;
  reconstruct(input: ReconstructionInput): Promise<ReconstructionResult>;
}

export class MeshProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${provider}: ${message}`, options);
    this.name = 'MeshProviderError';
  }
}

/** Shared polling helper for vendors that run reconstruction asynchronously. */
export async function pollUntil<T>(
  poll: () => Promise<{ done: boolean; failed?: string; progress?: number; value?: T }>,
  options: {
    provider: string;
    timeoutMs?: number;
    intervalMs?: number;
    onProgress?: (progress: number, message: string) => void | Promise<void>;
  },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await poll();
    if (state.failed) throw new MeshProviderError(options.provider, state.failed);
    if (state.done) {
      if (state.value === undefined) {
        throw new MeshProviderError(options.provider, 'finished without producing a mesh');
      }
      return state.value;
    }
    await options.onProgress?.(
      // Reserve the last 15% for download and post-processing.
      0.2 + (state.progress ?? 0) * 0.65,
      `Reconstructing (${Math.round((state.progress ?? 0) * 100)}%)`,
    );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new MeshProviderError(options.provider, `timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export async function fetchBinary(url: string, provider: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new MeshProviderError(provider, `download failed: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
