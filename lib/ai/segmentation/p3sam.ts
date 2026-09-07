import { env } from '@/lib/env';

import { parseNpyIntArray } from './npy';
import {
  PartSegmentationProviderError,
  type PartSegmentationInput,
  type PartSegmentationProvider,
  type PartSegmentationResult,
} from './types';

interface ResolvedP3SamOptions {
  postprocess: boolean;
  postprocessThreshold: number;
  seed: number;
}

/**
 * P3-SAM (Tencent Hunyuan3D-Part) adapter, talking directly to the model's
 * public Gradio Space over its REST contract - no Python/`gradio_client`
 * dependency.
 *
 * Source verified by reading the Space's own `app.py`
 * (https://huggingface.co/spaces/tencent/Hunyuan3D-Part/blob/main/app.py) and
 * `/gradio_api/info`, both fetched during this evaluation:
 *
 *   @spaces.GPU
 *   def segment(mesh_path, postprocess=True, postprocess_threshold=0.95, seed=42):
 *       ...
 *       aabb, face_ids, mesh = automask.predict_aabb(mesh, seed=seed, ...)
 *       ...
 *       mesh_save.export(file_path)              # -> "Segmentation Result" (glb)
 *       np.save(face_id_save_path, face_ids)      # -> "Face ID" (.npy)
 *       return file_path, face_id_save_path, gr_state
 *
 * `/gradio_api/info` confirms the two REST-visible outputs (the third,
 * `gr_state`, is a `gr.State` component and never crosses the API): a
 * `Model3D` (`segmentation_result`, a mesh file) and a `File` (`face_id`).
 *
 * `face_id` format (P3-SAM/demo/auto_mask.py, `save_mesh`/`fix_label`): a
 * NumPy `.npy` int array, one entry per triangle of the RETURNED mesh (P3-SAM
 * cleans/re-triangulates before segmenting, so this need not line up 1:1 with
 * the input mesh's face count or order), value = segment id, or `-1` for a
 * face the model left unlabelled. Parsed by `parseNpyIntArray` (./npy.ts).
 * High confidence: this is read directly from the maintainers' own source,
 * not inferred - but it has not been exercised against a live response
 * during this task (see the module-level caveat in ./index.ts and the PR
 * description: the public Space's free ZeroGPU quota was already exhausted
 * during evaluation).
 *
 * Protocol (Gradio 5.46.1, confirmed against the live Space):
 *   1. POST {space}/gradio_api/upload  (multipart, field "files") -> ["/tmp/gradio/.../mesh.glb"]
 *   2. POST {space}/gradio_api/call/segment  { data: [FileData, postprocess, threshold, seed] } -> { event_id }
 *   3. GET  {space}/gradio_api/call/segment/{event_id}  (SSE) -> "event: complete" carries the two FileData results
 *   4. Download each FileData's `url` (falls back to `{space}/gradio_api/file={path}`
 *      if the event payload omits it - the API always includes it in practice).
 */

interface GradioFileData {
  path: string;
  url?: string | null;
  orig_name?: string | null;
  mime_type?: string | null;
}

export class P3SamProvider implements PartSegmentationProvider {
  readonly name = 'p3sam';
  /**
   * Always true: this hits a public Space with no required secret.
   * `HUGGINGFACE_TOKEN` (optional) only raises the ZeroGPU quota - the
   * anonymous quota is small enough to exhaust in routine evaluation use, see
   * `submit()` below.
   */
  readonly configured = true;

  private get spaceUrl(): string {
    return env.p3samSpaceUrl.replace(/\/+$/, '');
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (env.huggingfaceToken) headers.Authorization = `Bearer ${env.huggingfaceToken}`;
    return headers;
  }

  /** Uploads the glb to the Space's temp storage; returns its server-side path. */
  private async upload(glb: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append('files', new Blob([glb as BlobPart], { type: 'model/gltf-binary' }), 'mesh.glb');

    const res = await fetch(`${this.spaceUrl}/gradio_api/upload`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) {
      throw new PartSegmentationProviderError(this.name, `upload failed: ${res.status} ${await res.text()}`);
    }
    const paths = (await res.json()) as string[];
    const path = paths[0];
    if (!path) throw new PartSegmentationProviderError(this.name, 'upload returned no file path');
    return path;
  }

  /** Queues the `/segment` call; returns the event id to poll for a result. */
  private async submit(uploadedPath: string, options: ResolvedP3SamOptions): Promise<string> {
    const res = await fetch(`${this.spaceUrl}/gradio_api/call/segment`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        data: [
          { path: uploadedPath, orig_name: 'mesh.glb', mime_type: 'model/gltf-binary', meta: { _type: 'gradio.FileData' } },
          options.postprocess,
          options.postprocessThreshold,
          options.seed,
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // The Space runs on HuggingFace's shared "ZeroGPU" pool, whose anonymous
      // quota is small enough to exhaust in routine evaluation - flagged with
      // a clearer message than the raw HTTP status, since this is the failure
      // this adapter is most likely to actually hit.
      if (res.status === 429 || /exceeded your zerogpu/i.test(body)) {
        throw new PartSegmentationProviderError(
          this.name,
          `ZeroGPU quota exceeded (${res.status}) - set HUGGINGFACE_TOKEN for a higher quota: ${body}`,
        );
      }
      throw new PartSegmentationProviderError(this.name, `submit failed: ${res.status} ${body}`);
    }
    const body = (await res.json()) as { event_id?: string };
    if (!body.event_id) throw new PartSegmentationProviderError(this.name, 'submit returned no event_id');
    return body.event_id;
  }

  /**
   * Streams the SSE result endpoint and resolves with the two file outputs
   * from the "complete" event (the third output, `gr_state`, is not exposed
   * over the API - see the module doc).
   */
  private async awaitResult(eventId: string, timeoutMs: number): Promise<[GradioFileData, GradioFileData]> {
    const res = await fetch(`${this.spaceUrl}/gradio_api/call/segment/${eventId}`, {
      headers: this.headers({ Accept: 'text/event-stream' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) {
      throw new PartSegmentationProviderError(
        this.name,
        `result stream failed: ${res.status} ${await res.text().catch(() => '')}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex = buffer.indexOf('\n\n');
        while (sepIndex !== -1) {
          const raw = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          sepIndex = buffer.indexOf('\n\n');

          let event = 'message';
          let data = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
            else if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
          }
          if (!data) continue;

          if (event === 'error') {
            throw new PartSegmentationProviderError(this.name, `job failed: ${data}`);
          }
          if (event === 'complete') {
            const parsed = JSON.parse(data) as [GradioFileData, GradioFileData, ...unknown[]];
            return [parsed[0], parsed[1]];
          }
          // "generating" (heartbeats while the GPU job runs) - keep reading.
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new PartSegmentationProviderError(this.name, 'result stream ended without a "complete" event');
  }

  private fileUrl(file: GradioFileData): string {
    return file.url ?? `${this.spaceUrl}/gradio_api/file=${file.path}`;
  }

  private async download(file: GradioFileData, what: string): Promise<Uint8Array> {
    const res = await fetch(this.fileUrl(file), { headers: this.headers() });
    if (!res.ok) throw new PartSegmentationProviderError(this.name, `${what} download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async segmentParts(input: PartSegmentationInput): Promise<PartSegmentationResult> {
    const resolved: ResolvedP3SamOptions = {
      postprocess: input.postprocess ?? true,
      postprocessThreshold: input.postprocessThreshold ?? 0.95,
      seed: input.seed ?? 42,
    };

    const uploadedPath = await this.upload(input.meshGlb);
    const eventId = await this.submit(uploadedPath, resolved);
    const [meshFile, faceIdFile] = await this.awaitResult(eventId, 10 * 60_000);

    const [segmentedGlb, faceIdBytes] = await Promise.all([
      this.download(meshFile, 'segmentation mesh'),
      this.download(faceIdFile, 'face_id'),
    ]);

    const { values: faceIds } = parseNpyIntArray(faceIdBytes, this.name);

    const bySegment = new Map<number, number[]>();
    const unassignedFaceIndices: number[] = [];
    faceIds.forEach((id, faceIndex) => {
      if (id < 0) {
        unassignedFaceIndices.push(faceIndex);
        return;
      }
      const existing = bySegment.get(id);
      if (existing) existing.push(faceIndex);
      else bySegment.set(id, [faceIndex]);
    });

    const segments = [...bySegment.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, faceIndices]) => ({ id: String(id), faceIndices, score: null }));

    return {
      segments,
      unassignedFaceIndices,
      segmentedGlb,
      providerJobId: eventId,
    };
  }
}
