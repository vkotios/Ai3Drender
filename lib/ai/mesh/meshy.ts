import { env } from '@/lib/env';

import {
  MeshProviderError,
  fetchBinary,
  pollUntil,
  type MeshProvider,
  type ReconstructionInput,
  type ReconstructionResult,
} from './types';

const API = 'https://api.meshy.ai/openapi/v1';

interface MeshyTask {
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress?: number;
  task_error?: { message?: string };
  model_urls?: { glb?: string };
}

/**
 * Meshy image-to-3D. Multi-image mode is used when the view synthesis stage
 * produced a turntable, which materially improves the back and underside.
 */
export class MeshyProvider implements MeshProvider {
  readonly name = 'meshy';
  readonly configured = Boolean(env.meshyApiKey);

  private headers(): Record<string, string> {
    if (!env.meshyApiKey) throw new MeshProviderError(this.name, 'MESHY_API_KEY is not set');
    return {
      Authorization: `Bearer ${env.meshyApiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async reconstruct(input: ReconstructionInput): Promise<ReconstructionResult> {
    if (input.imageUrls.length === 0) {
      throw new MeshProviderError(this.name, 'no reachable image URLs to reconstruct from');
    }
    await input.onProgress?.(0.1, 'Submitting to Meshy');

    const created = await fetch(`${API}/image-to-3d`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        // Meshy takes a single `image_url` or up to four `image_urls`.
        ...(input.imageUrls.length > 1
          ? { image_urls: input.imageUrls.slice(0, 4) }
          : { image_url: input.imageUrls[0] }),
        ai_model: 'meshy-5',
        topology: 'quad',
        target_polycount: 60_000,
        should_texture: true,
        texture_prompt: input.notes.slice(0, 600),
        symmetry_mode: input.spec.symmetry === 'bilateral' ? 'on' : 'auto',
      }),
    });
    if (!created.ok) {
      throw new MeshProviderError(this.name, `submit failed: ${created.status} ${await created.text()}`);
    }
    const { result: taskId } = (await created.json()) as { result: string };

    const glbUrl = await pollUntil<string>(
      async () => {
        const res = await fetch(`${API}/image-to-3d/${taskId}`, { headers: this.headers() });
        if (!res.ok) throw new MeshProviderError(this.name, `poll failed: ${res.status}`);
        const task = (await res.json()) as MeshyTask;
        if (task.status === 'FAILED' || task.status === 'CANCELED') {
          return { done: true, failed: task.task_error?.message ?? task.status };
        }
        if (task.status === 'SUCCEEDED') {
          return { done: true, value: task.model_urls?.glb };
        }
        return { done: false, progress: (task.progress ?? 0) / 100 };
      },
      { provider: this.name, onProgress: input.onProgress },
    );

    await input.onProgress?.(0.9, 'Downloading mesh');
    return {
      glb: await fetchBinary(glbUrl, this.name),
      providerJobId: taskId,
      // Meshy returns a unit-normalised mesh; the pipeline rescales from spec.
      extentMm: null,
    };
  }
}
