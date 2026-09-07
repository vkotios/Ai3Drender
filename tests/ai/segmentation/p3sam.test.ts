import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/env.ts` computes its exported `env` once at import time, so - same as
 * tests/notify/slack.test.ts - toggling P3SAM_SPACE_URL/HUGGINGFACE_TOKEN
 * between tests means re-mocking the module and re-importing the adapter
 * fresh each time. `PartSegmentationProviderError` is re-exported from the
 * same fresh module graph rather than imported statically at the top of this
 * file - `vi.resetModules()` gives every import after it a distinct module
 * instance, so a statically-imported class would fail `instanceof` checks
 * against errors thrown by the freshly-imported adapter.
 */
async function importWithEnv(env: { p3samSpaceUrl: string; huggingfaceToken: string | null }) {
  vi.resetModules();
  vi.doMock('@/lib/env', () => ({ env }));
  const { P3SamProvider } = await import('@/lib/ai/segmentation/p3sam');
  const { PartSegmentationProviderError } = await import('@/lib/ai/segmentation/types');
  return { P3SamProvider, PartSegmentationProviderError };
}

const SPACE = 'https://p3sam.test.space';

/** A minimal valid int32 .npy file, per numpy's format spec - see tests/ai/segmentation/npy.test.ts. */
function buildFaceIdNpy(values: number[]): Uint8Array {
  let header = `{'descr': '<i4', 'fortran_order': False, 'shape': (${values.length},), }`;
  const pad = (64 - ((10 + header.length + 1) % 64)) % 64;
  header = header + ' '.repeat(pad) + '\n';
  const headerBytes = new TextEncoder().encode(header);
  const dataBytes = new Uint8Array(values.length * 4);
  const view = new DataView(dataBytes.buffer);
  values.forEach((v, i) => view.setInt32(i * 4, v, true));
  const out = new Uint8Array(10 + headerBytes.length + dataBytes.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 0);
  out[6] = 1;
  out[7] = 0;
  new DataView(out.buffer).setUint16(8, headerBytes.length, true);
  out.set(headerBytes, 10);
  out.set(dataBytes, 10 + headerBytes.length);
  return out;
}

/** Builds the SSE body `/gradio_api/call/segment/<event_id>` streams back on success. */
function sseCompleteBody(data: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = `event: generating\ndata: null\n\nevent: complete\ndata: ${JSON.stringify(data)}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('P3SamProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@/lib/env');
    vi.resetModules();
  });

  it('is always configured - the default Space needs no secret', async () => {
    const { P3SamProvider } = await importWithEnv({ p3samSpaceUrl: SPACE, huggingfaceToken: null });
    const provider = new P3SamProvider();
    expect(provider.name).toBe('p3sam');
    expect(provider.configured).toBe(true);
  });

  it('uploads, submits, streams the SSE result, downloads both files, and groups faces by segment id', async () => {
    const meshBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const faceIds = [0, 0, 1, -1, 1, 2]; // 6 faces: segment 0 x2, segment 1 x2, segment 2 x1, 1 unassigned
    const npyBytes = buildFaceIdNpy(faceIds);

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `${SPACE}/gradio_api/upload`) {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeInstanceOf(FormData);
        return jsonResponse(['/tmp/gradio/abc/mesh.glb']);
      }
      if (url === `${SPACE}/gradio_api/call/segment`) {
        expect(init?.method).toBe('POST');
        const payload = JSON.parse(init!.body as string) as { data: unknown[] };
        expect(payload.data[0]).toMatchObject({ path: '/tmp/gradio/abc/mesh.glb' });
        expect(payload.data.slice(1)).toEqual([true, 0.95, 42]);
        return jsonResponse({ event_id: 'evt-1' });
      }
      if (url === `${SPACE}/gradio_api/call/segment/evt-1`) {
        return {
          ok: true,
          body: sseCompleteBody([
            { path: '/tmp/gradio/out/segment_mesh.glb', url: 'https://files.test/mesh.glb' },
            { path: '/tmp/gradio/out/face_id.npy', url: 'https://files.test/face_id.npy' },
          ]),
        } as unknown as Response;
      }
      if (url === 'https://files.test/mesh.glb') {
        return { ok: true, arrayBuffer: async () => meshBytes.buffer } as unknown as Response;
      }
      if (url === 'https://files.test/face_id.npy') {
        return { ok: true, arrayBuffer: async () => npyBytes.buffer } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { P3SamProvider } = await importWithEnv({ p3samSpaceUrl: SPACE, huggingfaceToken: null });
    const provider = new P3SamProvider();

    const result = await provider.segmentParts({ meshGlb: new Uint8Array([9, 9, 9]) });

    expect(result.providerJobId).toBe('evt-1');
    expect(result.unassignedFaceIndices).toEqual([3]);
    expect(result.segments).toEqual([
      { id: '0', faceIndices: [0, 1], score: null },
      { id: '1', faceIndices: [2, 4], score: null },
      { id: '2', faceIndices: [5], score: null },
    ]);
    expect(result.segmentedGlb).toEqual(meshBytes);

    // No Authorization header when no token is configured.
    const uploadCall = fetchMock.mock.calls.find(([url]) => url === `${SPACE}/gradio_api/upload`)!;
    expect((uploadCall[1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sends an Authorization bearer header on every request when HUGGINGFACE_TOKEN is set', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${SPACE}/gradio_api/upload`) return jsonResponse(['/tmp/x/mesh.glb']);
      if (url === `${SPACE}/gradio_api/call/segment`) return jsonResponse({ event_id: 'evt-2' });
      if (url === `${SPACE}/gradio_api/call/segment/evt-2`) {
        return {
          ok: true,
          body: sseCompleteBody([
            { path: '/x/mesh.glb', url: 'https://files.test/mesh2.glb' },
            { path: '/x/face_id.npy', url: 'https://files.test/face_id2.npy' },
          ]),
        } as unknown as Response;
      }
      if (url === 'https://files.test/mesh2.glb') return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
      if (url === 'https://files.test/face_id2.npy') {
        return { ok: true, arrayBuffer: async () => buildFaceIdNpy([0]).buffer } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { P3SamProvider } = await importWithEnv({ p3samSpaceUrl: SPACE, huggingfaceToken: 'hf_secret123' });
    await new P3SamProvider().segmentParts({ meshGlb: new Uint8Array([1]) });

    for (const [, init] of fetchMock.mock.calls) {
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe('Bearer hf_secret123');
    }
  });

  it('raises a clear ZeroGPU-quota error when the Space rejects the job with a 429', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${SPACE}/gradio_api/upload`) return jsonResponse(['/tmp/x/mesh.glb']);
      if (url === `${SPACE}/gradio_api/call/segment`) {
        return jsonResponse(
          { error: 'You have exceeded your ZeroGPU runs limit. Authenticate with a Hugging Face token for more quota.' },
          false,
          429,
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { P3SamProvider } = await importWithEnv({ p3samSpaceUrl: SPACE, huggingfaceToken: null });
    await expect(new P3SamProvider().segmentParts({ meshGlb: new Uint8Array([1]) })).rejects.toThrow(
      /ZeroGPU quota exceeded/i,
    );
  });

  it('throws a typed PartSegmentationProviderError, not a bare Error, when upload fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse('server error', false, 500));

    const { P3SamProvider, PartSegmentationProviderError } = await importWithEnv({
      p3samSpaceUrl: SPACE,
      huggingfaceToken: null,
    });
    await expect(new P3SamProvider().segmentParts({ meshGlb: new Uint8Array([1]) })).rejects.toBeInstanceOf(
      PartSegmentationProviderError,
    );
  });

  it('surfaces an "error" SSE event as a failure rather than hanging', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${SPACE}/gradio_api/upload`) return jsonResponse(['/tmp/x/mesh.glb']);
      if (url === `${SPACE}/gradio_api/call/segment`) return jsonResponse({ event_id: 'evt-3' });
      if (url === `${SPACE}/gradio_api/call/segment/evt-3`) {
        const encoder = new TextEncoder();
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('event: error\ndata: "GPU task failed"\n\n'));
              controller.close();
            },
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { P3SamProvider } = await importWithEnv({ p3samSpaceUrl: SPACE, huggingfaceToken: null });
    await expect(new P3SamProvider().segmentParts({ meshGlb: new Uint8Array([1]) })).rejects.toThrow(/job failed/i);
  });

  it('falls back to constructing a gradio_api/file= URL when a FileData result omits `url`', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${SPACE}/gradio_api/upload`) return jsonResponse(['/tmp/x/mesh.glb']);
      if (url === `${SPACE}/gradio_api/call/segment`) return jsonResponse({ event_id: 'evt-4' });
      if (url === `${SPACE}/gradio_api/call/segment/evt-4`) {
        return {
          ok: true,
          body: sseCompleteBody([
            { path: '/tmp/out/mesh.glb' },
            { path: '/tmp/out/face_id.npy' },
          ]),
        } as unknown as Response;
      }
      if (url === `${SPACE}/gradio_api/file=/tmp/out/mesh.glb`) {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
      }
      if (url === `${SPACE}/gradio_api/file=/tmp/out/face_id.npy`) {
        return { ok: true, arrayBuffer: async () => buildFaceIdNpy([0]).buffer } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { P3SamProvider } = await importWithEnv({ p3samSpaceUrl: SPACE, huggingfaceToken: null });
    const result = await new P3SamProvider().segmentParts({ meshGlb: new Uint8Array([1]) });
    expect(result.segments).toEqual([{ id: '0', faceIndices: [0], score: null }]);
  });
});
