import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { drainJobs } from '@/lib/pipeline';
import type { FurnitureAsset, Project } from '@/lib/types';

/**
 * End-to-end check for issue #43's verification bar: create an asset, drain
 * the queue including `reconstruct`, and confirm a `qaResult` ends up on the
 * version *and is fetchable through the real GET /api/assets/:assetId route*
 * - not just present on the object `store.getAssetVersion` returns.
 *
 * `getSession` is mocked (the same way tests/api/authorization.test.ts does)
 * so the route runs against a real LocalStore without a live Supabase session;
 * no GEMINI_API_KEY is set (see tests/setup.ts), so this exercises the
 * documented offline-placeholder path, not a live Gemini call.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { GET } = await import('@/app/api/assets/[assetId]/route');

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-qa-endpoint-'));
  store = new LocalStore(dir);
  vi.mocked(getSession).mockResolvedValue({ store, viewer: { id: 'owner-1', email: 'owner-1@test' } });

  project = await store.createProject({ ownerId: 'owner-1', name: 'QA endpoint test' });

  const imagePath = `${project.id}/sources/sofa-front.jpg`;
  await store.putBlob(imagePath, new Uint8Array([1, 2, 3, 4]), 'image/jpeg');
  const image = await store.addSourceImage({
    projectId: project.id,
    path: imagePath,
    filename: 'sofa-front.jpg',
    mimeType: 'image/jpeg',
    byteSize: 4,
    role: 'primary',
  });

  asset = await store.createAsset({
    projectId: project.id,
    name: '',
    status: 'draft',
    currentVersionId: null,
    sourceImageIds: [image.id],
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/assets/:assetId', () => {
  it('surfaces the offline QA placeholder on the current version once reconstruct has run', async () => {
    await store.createJob({ projectId: project.id, assetId: asset.id, kind: 'analyze', input: {} });
    for (let i = 0; i < 20; i += 1) {
      const processed = await drainJobs(store, 1);
      if (processed === 0) break;
    }

    const response = await GET(new Request(`http://test/api/assets/${asset.id}`), {
      params: Promise.resolve({ assetId: asset.id }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      asset: FurnitureAsset;
      versions: { version: { id: string; qaResult: unknown } }[];
    };
    expect(body.asset.status).toBe('ready');

    const current = body.versions.find((v) => v.version.id === body.asset.currentVersionId);
    expect(current?.version.qaResult).toEqual({ score: 100, defects: [], source: 'offline' });
  });
});
