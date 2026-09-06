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
    generateContent.mockResolvedValue({ text: JSON.stringify({ score: 91, issues: [] }) });

    const spec = makeFurnitureSpec();
    await evaluateReconstruction([photo], [meshView], spec);

    expect(generateContent).toHaveBeenCalledTimes(1);
    const call = generateContent.mock.calls[0][0];
    expect(call.config.responseMimeType).toBe('application/json');
    expect(call.config.responseSchema.required).toEqual(expect.arrayContaining(['score', 'issues']));

    const parts = call.contents[0].parts as Record<string, unknown>[];
    const imageParts = parts.filter((p) => 'inlineData' in p);
    // One inline image per source photo plus one per mesh view.
    expect(imageParts).toHaveLength(2);
    expect(imageParts.some((p) => (p.inlineData as { mimeType: string }).mimeType === 'image/jpeg')).toBe(true);
    expect(imageParts.some((p) => (p.inlineData as { mimeType: string }).mimeType === 'image/png')).toBe(true);

    // The piece's own description reaches the prompt, so the model has context.
    const text = parts.map((p) => (p as { text?: string }).text).filter(Boolean).join('\n');
    expect(text).toContain(spec.displayName);
  });

  it('parses a fenced JSON response, clamps the score, and drops empty issue strings', async () => {
    generateContent.mockResolvedValue({
      text: '```json\n{"score": 143, "issues": ["missing armrest", ""]}\n```',
    });

    const result = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());

    expect(result.source).toBe('gemini');
    expect(result.score).toBe(100); // clamped to the documented 0-100 range
    expect(result.issues).toEqual(['missing armrest']);
  });

  it('clamps a negative or missing score into range rather than propagating garbage', async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify({ score: -12, issues: [] }) });
    const negative = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());
    expect(negative.score).toBe(0);

    generateContent.mockResolvedValue({ text: JSON.stringify({ issues: [] }) });
    const missing = await evaluateReconstruction([photo], [meshView], makeFurnitureSpec());
    expect(missing.score).toBe(0);
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
