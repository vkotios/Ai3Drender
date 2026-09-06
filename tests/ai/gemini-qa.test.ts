import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `evaluateReconstruction` (lib/ai/gemini.ts) is the one function in this
 * module this repo cannot exercise against a live Gemini API in this sandbox
 * (no GEMINI_API_KEY - see tests/setup.ts, which forces every test onto the
 * offline path by default). This mocks the SDK client the same way
 * tests/api/authorization.test.ts mocks a module boundary, so the prompt/
 * schema construction and response-parsing logic can still be checked in
 * isolation, structurally, against what the SDK's documented types expect.
 */

const generateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, hasGemini: true, env: { ...actual.env, geminiApiKey: 'test-key' } };
});

const { evaluateReconstruction } = await import('@/lib/ai/gemini');
const { offlineQaResult } = await import('@/lib/ai/offline');
const { makeFurnitureSpec } = await import('../fixtures');

const photo = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', filename: 'front.jpg', role: 'primary' };
const meshView = { angle: 'front', image: { bytes: new Uint8Array([4, 5, 6]), mimeType: 'image/png' } };

beforeEach(() => {
  generateContent.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('evaluateReconstruction', () => {
  it('sends the source photos and the rendered mesh views as inline image parts, with a JSON schema config', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ score: 91, defects: [] }) });

    const spec = makeFurnitureSpec();
    await evaluateReconstruction([photo], [meshView], spec);

    expect(generateContent).toHaveBeenCalledTimes(1);
    const call = generateContent.mock.calls[0][0];
    expect(call.config.responseMimeType).toBe('application/json');
    expect(call.config.responseSchema.required).toEqual(expect.arrayContaining(['score', 'defects']));

    const parts = call.contents[0].parts as Record<string, unknown>[];
    const imageParts = parts.filter((p) => 'inlineData' in p);
    // One inline image per source photo plus one per mesh view.
    expect(imageParts).toHaveLength(2);
    expect(imageParts.some((p) => (p.inlineData as { mimeType: string }).mimeType === 'image/jpeg')).toBe(true);
    expect(imageParts.some((p) => (p.inlineData as { mimeType: string }).mimeType === 'image/png')).toBe(true);

    // The piece's own description reaches the prompt, so the model has context.
    const text = parts.map((p) => (p as { text?: string }).text).filter(Boolean).join('\n');
    expect(text).toContain(spec.displayName);
    // The piece's named components are offered too, so the model can attribute a
    // defect to one of them (see `formatKnownComponents`).
    expect(text).toContain('"Legs" (role: leg)');
  });

  it('parses a fenced JSON response, clamps the score, and resolves a defect componentName against the spec', async () => {
    generateContent.mockResolvedValue({
      text:
        '```json\n' +
        JSON.stringify({
          score: 143,
          defects: [
            { category: 'missing_geometry', description: 'missing armrest', severity: 'severe', componentName: 'Legs' },
          ],
        }) +
        '\n```',
    });

    const result = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());

    expect(result.source).toBe('gemini');
    expect(result.score).toBe(100); // clamped to the documented 0-100 range
    expect(result.defects).toEqual([
      { category: 'missing_geometry', description: 'missing armrest', severity: 'severe', componentName: 'Legs' },
    ]);
  });

  it('drops a defect with an unrecognised category or an empty description, but keeps a valid one', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        score: 50,
        defects: [
          { category: 'made_up_category', description: 'not a real category', severity: 'minor', componentName: null },
          { category: 'form_defect', description: '   ', severity: 'minor', componentName: null },
          { category: 'texture_defect', description: 'seat cushion is grey, not tan', severity: 'moderate', componentName: null },
        ],
      }),
    });

    const result = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());
    expect(result.defects).toEqual([
      { category: 'texture_defect', description: 'seat cushion is grey, not tan', severity: 'moderate', componentName: null },
    ]);
  });

  it('defaults an unrecognised severity to "moderate" rather than dropping the defect', async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        score: 50,
        defects: [{ category: 'surface_defect', description: 'rough patch on the seat', severity: 'catastrophic', componentName: null }],
      }),
    });

    const result = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());
    expect(result.defects[0].severity).toBe('moderate');
  });

  it("resolves a defect's componentName by role too, and nulls it out when it matches no known component", async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        score: 50,
        defects: [
          { category: 'form_defect', description: 'legs read too thick', severity: 'moderate', componentName: 'leg' },
          { category: 'form_defect', description: 'overall proportions off', severity: 'minor', componentName: 'nonexistent part' },
        ],
      }),
    });

    const result = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());
    expect(result.defects[0].componentName).toBe('Legs'); // matched by role, canonicalised to the component's name
    expect(result.defects[1].componentName).toBeNull();
  });

  it('clamps a negative or missing score into range rather than propagating garbage', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ score: -12, defects: [] }) });
    const negative = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());
    expect(negative.score).toBe(0);

    generateContent.mockResolvedValue({ text: JSON.stringify({ defects: [] }) });
    const missing = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());
    expect(missing.score).toBe(0);
  });

  it('treats a non-array defects field as no defects rather than throwing', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ score: 80, defects: 'not an array' }) });
    const result = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());
    expect(result.defects).toEqual([]);
  });

  it('falls back to the offline placeholder without calling the model when there are no mesh views', async () => {
    const result = await evaluateReconstruction([photo], [], makeFurnitureSpec());
    expect(generateContent).not.toHaveBeenCalled();
    expect(result).toEqual(offlineQaResult());
  });

  it('falls back to the offline placeholder when only mood photos are available', async () => {
    const moodOnly = { ...photo, role: 'mood' };
    const result = await evaluateReconstruction([moodOnly], [meshView], makeFurnitureSpec());
    expect(generateContent).not.toHaveBeenCalled();
    expect(result).toEqual(offlineQaResult());
  });

  it('surfaces a non-JSON model response as a thrown error rather than a silently wrong QaResult', async () => {
    generateContent.mockResolvedValue({ text: 'not json' });
    await expect(evaluateReconstruction([photo], [meshView], makeFurnitureSpec())).rejects.toThrow(
      /valid JSON/,
    );
  });
});
