import { env } from '@/lib/env';

import {
  PartSegmentationProviderError,
  type PartSegment,
  type PartSegmentationInput,
  type PartSegmentationProvider,
  type PartSegmentationResult,
} from './types';

/**
 * Point-SAM (https://github.com/zyc00/Point-SAM, MIT licensed) adapter.
 *
 * Unlike every `MeshProvider` in lib/ai/mesh, this does not call a hosted
 * vendor API - no reliable public Point-SAM endpoint exists (the one known
 * community Space was in a broken build state as of this evaluation), and
 * the model is point-prompted only with no vendor offering it as a hosted
 * product. It instead calls a self-hosted inference service this app's
 * operator deploys themselves - see services/pointsam/ in this repo for the
 * FastAPI wrapper this adapter is written against, and that directory's
 * README for how to run it (it needs a CUDA GPU; nothing in this app's own
 * deploy provides one).
 *
 * The JSON contract below is this evaluation's own design, not something
 * Point-SAM or anyone else publishes - services/pointsam/app.py is both
 * halves of it, so keep the two in sync.
 */

interface PointSamSegmentResponse {
  job_id?: string;
  segments: { id: string; face_indices: number[]; score?: number }[];
}

export class PointSamProvider implements PartSegmentationProvider {
  readonly name = 'point-sam';
  readonly configured = Boolean(env.pointSamServiceUrl);

  async segmentParts(input: PartSegmentationInput): Promise<PartSegmentationResult> {
    if (!env.pointSamServiceUrl) {
      throw new PartSegmentationProviderError(this.name, 'POINTSAM_SERVICE_URL is not set');
    }
    if (!input.promptPoint) {
      // Point-SAM has no whole-mesh automatic mode (see the type comment on
      // `promptPoint`) - there is nothing to click on the mesh without one.
      throw new PartSegmentationProviderError(
        this.name,
        'a promptPoint is required - Point-SAM segments the part containing a given 3D point, it does not segment a whole mesh automatically',
      );
    }

    await input.onProgress?.(0.1, 'Submitting to self-hosted Point-SAM service');

    const response = await fetch(`${env.pointSamServiceUrl}/segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mesh_glb_base64: Buffer.from(input.meshGlb).toString('base64'),
        prompt_point: [input.promptPoint.x, input.promptPoint.y, input.promptPoint.z],
        prompt_label: input.promptPoint.label ?? 1,
      }),
    });

    if (!response.ok) {
      throw new PartSegmentationProviderError(
        this.name,
        `segment request failed: ${response.status} ${await response.text()}`,
      );
    }

    let payload: PointSamSegmentResponse;
    try {
      payload = (await response.json()) as PointSamSegmentResponse;
    } catch (cause) {
      throw new PartSegmentationProviderError(this.name, 'response was not valid JSON', { cause });
    }
    if (!Array.isArray(payload.segments)) {
      throw new PartSegmentationProviderError(this.name, 'response contained no segments array');
    }

    await input.onProgress?.(0.9, 'Segmentation complete');

    const segments: PartSegment[] = payload.segments.map((s) => ({
      id: s.id,
      faceIndices: s.face_indices,
      score: typeof s.score === 'number' ? s.score : null,
    }));

    return { segments, providerJobId: payload.job_id ?? null };
  }
}
