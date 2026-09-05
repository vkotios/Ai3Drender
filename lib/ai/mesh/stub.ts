import { buildMassingGlb } from './massing';
import type { MeshProvider, ReconstructionInput, ReconstructionResult } from './types';

/**
 * Default provider. Produces a real, correctly-scaled .glb block model from the
 * spec instead of calling any vendor.
 *
 * It exists so the full pipeline - analysis, view synthesis, reconstruction,
 * staging, export - runs with no third-party accounts, and so the app has a
 * deterministic path for tests and demos. It does not perform reconstruction;
 * set MESH_PROVIDER to a real vendor for that.
 */
export class StubMeshProvider implements MeshProvider {
  readonly name = 'stub';
  readonly configured = true;

  async reconstruct(input: ReconstructionInput): Promise<ReconstructionResult> {
    await input.onProgress?.(0.4, 'Building proportional block model');
    const glb = buildMassingGlb(input.spec);
    await input.onProgress?.(0.9, 'Block model ready');

    const { widthMm, depthMm, heightMm } = input.spec.dimensions;
    return {
      glb,
      providerJobId: null,
      // The massing generator works in real-world units already.
      extentMm: Math.max(widthMm, depthMm, heightMm),
    };
  }
}
