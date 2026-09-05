import { env } from '@/lib/env';

import {
  MeshProviderError,
  fetchBinary,
  pollUntil,
  type MeshProvider,
  type ReconstructionInput,
  type ReconstructionResult,
} from './types';

const QUEUE = 'https://queue.fal.run';

/**
 * fal.ai queue adapter. The model route is configurable (FAL_MESH_MODEL) since
 * fal hosts several image-to-3D models behind the same queue protocol.
 */
export class FalProvider implements MeshProvider {
  readonly name = 'fal';
  readonly configured = Boolean(env.falApiKey);

  private headers(): Record<string, string> {
    if (!env.falApiKey) throw new MeshProviderError(this.name, 'FAL_API_KEY is not set');
    return { Authorization: `Key ${env.falApiKey}`, 'Content-Type': 'application/json' };
  }

  async reconstruct(input: ReconstructionInput): Promise<ReconstructionResult> {
    if (input.imageUrls.length === 0) {
      throw new MeshProviderError(this.name, 'no reachable image URLs to reconstruct from');
    }
    await input.onProgress?.(0.1, `Submitting to fal (${env.falMeshModel})`);

    const created = await fetch(`${QUEUE}/${env.falMeshModel}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        input_image_url: input.imageUrls[0],
        // Several fal 3D models accept extra views under this key and ignore
        // it when unsupported.
        additional_image_urls: input.imageUrls.slice(1, 4),
        textured_mesh: true,
      }),
    });
    if (!created.ok) {
      throw new MeshProviderError(this.name, `submit failed: ${created.status} ${await created.text()}`);
    }
    const { request_id: requestId, status_url: statusUrl, response_url: responseUrl } =
      (await created.json()) as { request_id: string; status_url: string; response_url: string };

    await pollUntil<true>(
      async () => {
        const res = await fetch(statusUrl, { headers: this.headers() });
        if (!res.ok) throw new MeshProviderError(this.name, `poll failed: ${res.status}`);
        const status = (await res.json()) as { status: string; queue_position?: number };
        if (status.status === 'COMPLETED') return { done: true, value: true };
        if (status.status === 'FAILED') return { done: true, failed: 'generation failed' };
        // fal reports queue position rather than a percentage.
        return { done: false, progress: status.status === 'IN_PROGRESS' ? 0.5 : 0.1 };
      },
      { provider: this.name, onProgress: input.onProgress },
    );

    const result = await fetch(responseUrl, { headers: this.headers() });
    if (!result.ok) throw new MeshProviderError(this.name, `result fetch failed: ${result.status}`);
    const payload = (await result.json()) as {
      model_mesh?: { url?: string };
      model_glb?: { url?: string };
    };
    const url = payload.model_mesh?.url ?? payload.model_glb?.url;
    if (!url) throw new MeshProviderError(this.name, 'response contained no mesh URL');

    await input.onProgress?.(0.9, 'Downloading mesh');
    return { glb: await fetchBinary(url, this.name), providerJobId: requestId, extentMm: null };
  }
}
