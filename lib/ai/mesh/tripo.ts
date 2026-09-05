import { env } from '@/lib/env';

import {
  MeshProviderError,
  fetchBinary,
  pollUntil,
  type MeshProvider,
  type ReconstructionInput,
  type ReconstructionResult,
} from './types';

const API = 'https://api.tripo3d.ai/v2/openapi';

interface TripoTask {
  data: {
    status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'banned' | 'expired';
    progress?: number;
    output?: { pbr_model?: string; model?: string };
  };
}

/** Tripo3D image-to-3D, uploading the images directly rather than by URL. */
export class TripoProvider implements MeshProvider {
  readonly name = 'tripo';
  readonly configured = Boolean(env.tripoApiKey);

  private authHeader(): Record<string, string> {
    if (!env.tripoApiKey) throw new MeshProviderError(this.name, 'TRIPO_API_KEY is not set');
    return { Authorization: `Bearer ${env.tripoApiKey}` };
  }

  /** Tripo references uploaded files by token rather than by URL. */
  private async upload(image: { bytes: Uint8Array; mimeType: string }): Promise<string> {
    const form = new FormData();
    const extension = image.mimeType.includes('png') ? 'png' : 'jpg';
    form.append('file', new Blob([image.bytes as BlobPart], { type: image.mimeType }), `view.${extension}`);

    const res = await fetch(`${API}/upload/sts`, {
      method: 'POST',
      headers: this.authHeader(),
      body: form,
    });
    if (!res.ok) throw new MeshProviderError(this.name, `upload failed: ${res.status}`);
    const json = (await res.json()) as { data: { image_token: string } };
    return json.data.image_token;
  }

  async reconstruct(input: ReconstructionInput): Promise<ReconstructionResult> {
    if (input.images.length === 0) {
      throw new MeshProviderError(this.name, 'no images to reconstruct from');
    }
    await input.onProgress?.(0.05, 'Uploading views to Tripo');
    const token = await this.upload(input.images[0]);

    await input.onProgress?.(0.1, 'Submitting to Tripo');
    const created = await fetch(`${API}/task`, {
      method: 'POST',
      headers: { ...this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'image_to_model',
        model_version: 'v2.5-20250123',
        file: { type: input.images[0].mimeType.includes('png') ? 'png' : 'jpg', file_token: token },
        texture: true,
        pbr: true,
      }),
    });
    if (!created.ok) {
      throw new MeshProviderError(this.name, `submit failed: ${created.status} ${await created.text()}`);
    }
    const { data } = (await created.json()) as { data: { task_id: string } };

    const modelUrl = await pollUntil<string>(
      async () => {
        const res = await fetch(`${API}/task/${data.task_id}`, { headers: this.authHeader() });
        if (!res.ok) throw new MeshProviderError(this.name, `poll failed: ${res.status}`);
        const task = (await res.json()) as TripoTask;
        if (['failed', 'cancelled', 'banned', 'expired'].includes(task.data.status)) {
          return { done: true, failed: task.data.status };
        }
        if (task.data.status === 'success') {
          return { done: true, value: task.data.output?.pbr_model ?? task.data.output?.model };
        }
        return { done: false, progress: (task.data.progress ?? 0) / 100 };
      },
      { provider: this.name, onProgress: input.onProgress },
    );

    await input.onProgress?.(0.9, 'Downloading mesh');
    return {
      glb: await fetchBinary(modelUrl, this.name),
      providerJobId: data.task_id,
      extentMm: null,
    };
  }
}
