import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/env.ts` computes its exported `env` object once, at import time, from
 * `process.env` (see tests/notify/slack.test.ts for the same pattern) - so
 * toggling POINTSAM_SERVICE_URL between tests means re-mocking the module
 * and re-importing PointSamProvider fresh each time.
 *
 * `vi.resetModules()` also gives that fresh import its own module instance
 * of `./types` - a `PartSegmentationProviderError` imported statically at
 * the top of this file would be a DIFFERENT class than the one thrown here,
 * so `PartSegmentationProviderError` is re-imported alongside the provider
 * on every call instead, to keep `instanceof` meaningful.
 */
async function importWithServiceUrl(url: string | null) {
  vi.resetModules();
  vi.doMock('@/lib/env', () => ({ env: { pointSamServiceUrl: url } }));
  const { PointSamProvider } = await import('@/lib/ai/segmentation/pointsam');
  const { PartSegmentationProviderError } = await import('@/lib/ai/segmentation/types');
  return { provider: new PointSamProvider(), PartSegmentationProviderError };
}

describe('PointSamProvider', () => {
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

  it('reports configured false when POINTSAM_SERVICE_URL is unset, true when set', async () => {
    const { provider: unconfigured } = await importWithServiceUrl(null);
    expect(unconfigured.configured).toBe(false);

    const { provider: configured } = await importWithServiceUrl('http://localhost:8000');
    expect(configured.configured).toBe(true);
  });

  it('throws without calling fetch when POINTSAM_SERVICE_URL is unset', async () => {
    const { provider, PartSegmentationProviderError } = await importWithServiceUrl(null);

    await expect(
      provider.segmentParts({ meshGlb: new Uint8Array([1, 2, 3]), promptPoint: { x: 0, y: 0, z: 0 } }),
    ).rejects.toThrow(PartSegmentationProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws without calling fetch when no promptPoint is given - Point-SAM has no automatic mode', async () => {
    const { provider } = await importWithServiceUrl('http://localhost:8000');

    await expect(provider.segmentParts({ meshGlb: new Uint8Array([1, 2, 3]) })).rejects.toThrow(
      /promptPoint/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the mesh (base64) and prompt point to <serviceUrl>/segment, defaulting label to 1', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ job_id: 'job-1', segments: [{ id: 'seg-0', face_indices: [0, 1, 2], score: 0.91 }] }),
    });
    const { provider } = await importWithServiceUrl('http://localhost:8000');

    const meshGlb = new Uint8Array([0x67, 0x6c, 0x54, 0x46]); // "glTF" magic, contents don't matter here
    await provider.segmentParts({ meshGlb, promptPoint: { x: 0.3, y: 0.2, z: -0.1 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8000/segment');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });

    const body = JSON.parse(init.body);
    expect(body.mesh_glb_base64).toBe(Buffer.from(meshGlb).toString('base64'));
    expect(body.prompt_point).toEqual([0.3, 0.2, -0.1]);
    expect(body.prompt_label).toBe(1);
  });

  it('passes an explicit exclusion label (0) through unchanged', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ segments: [] }) });
    const { provider } = await importWithServiceUrl('http://localhost:8000');

    await provider.segmentParts({
      meshGlb: new Uint8Array([1]),
      promptPoint: { x: 0, y: 0, z: 0, label: 0 },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prompt_label).toBe(0);
  });

  it('parses a realistic segment response into the port shape, defaulting a missing score to null', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: 'job-42',
        segments: [
          { id: 'seg-0', face_indices: [0, 1, 2, 3, 4, 5], score: 0.87 },
          { id: 'seg-1', face_indices: [6, 7, 8] },
        ],
      }),
    });
    const { provider } = await importWithServiceUrl('http://localhost:8000');

    const result = await provider.segmentParts({
      meshGlb: new Uint8Array([1]),
      promptPoint: { x: 0, y: 0.2, z: 0 },
    });

    expect(result.providerJobId).toBe('job-42');
    expect(result.segments).toEqual([
      { id: 'seg-0', faceIndices: [0, 1, 2, 3, 4, 5], score: 0.87 },
      { id: 'seg-1', faceIndices: [6, 7, 8], score: null },
    ]);
  });

  it('throws a typed error, without crashing, on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'GPU out of memory' });
    const { provider } = await importWithServiceUrl('http://localhost:8000');

    await expect(
      provider.segmentParts({ meshGlb: new Uint8Array([1]), promptPoint: { x: 0, y: 0, z: 0 } }),
    ).rejects.toThrow(/500/);
  });

  it('throws a typed error when the response has no segments array', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ job_id: 'job-1' }) });
    const { provider, PartSegmentationProviderError } = await importWithServiceUrl('http://localhost:8000');

    await expect(
      provider.segmentParts({ meshGlb: new Uint8Array([1]), promptPoint: { x: 0, y: 0, z: 0 } }),
    ).rejects.toThrow(PartSegmentationProviderError);
  });

  it('throws a typed error when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    const { provider, PartSegmentationProviderError } = await importWithServiceUrl('http://localhost:8000');

    await expect(
      provider.segmentParts({ meshGlb: new Uint8Array([1]), promptPoint: { x: 0, y: 0, z: 0 } }),
    ).rejects.toThrow(PartSegmentationProviderError);
  });
});
