import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import type { AssetVersion, FurnitureAsset, Project } from '@/lib/types';
import { makeComponent, makeFurnitureSpec, makeMaterial } from '../fixtures';

/**
 * Issue #57: `POST .../rebake-part` enqueues a `rebake_part` job (mirroring
 * `POST .../refine`, see `tests/pipeline/rebake-part.test.ts` for the job
 * itself running end to end) rather than doing the mesh work inline - unlike
 * the synchronous, mesh-untouched material spot-fix route (issue #48,
 * `tests/api/material-spot-fix.test.ts`), which this test file otherwise
 * mirrors closely.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { POST: rebakePart } = await import(
  '@/app/api/assets/[assetId]/versions/[versionId]/rebake-part/route'
);

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;

const OWNER = 'rebake-route-owner';

const jsonRequest = (body: unknown) =>
  new Request('http://local/api/rebake-part', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-rebake-route-'));
  store = new LocalStore(dir);
  vi.mocked(getSession).mockResolvedValue({ store, viewer: { id: OWNER, email: `${OWNER}@test` } });

  project = await store.createProject({ ownerId: OWNER, name: 'Rebake route project' });
  asset = await store.createAsset({
    projectId: project.id,
    name: 'Chair',
    status: 'ready',
    currentVersionId: null,
    sourceImageIds: [],
  });
});

afterEach(async () => {
  vi.mocked(getSession).mockReset();
  await rm(dir, { recursive: true, force: true });
});

async function createVersion(overrides: Partial<AssetVersion> = {}): Promise<AssetVersion> {
  const spec = makeFurnitureSpec({
    components: [
      makeComponent({ name: 'Legs', role: 'leg', materialId: 'frame' }),
      makeComponent({ name: 'Seat', role: 'seat', materialId: 'frame' }),
    ],
    materials: [makeMaterial({ id: 'frame' })],
  });

  return store.createAssetVersion({
    assetId: asset.id,
    versionNumber: 1,
    label: 'v1',
    parentVersionId: null,
    spec,
    views: [],
    meshPath: 'projects/p/versions/v/mesh.glb',
    meshExtentMm: 800,
    previewPath: null,
    provider: 'stub',
    providerJobId: null,
    refinement: null,
    qaResult: null,
    previewMeshPath: null,
    acceptedAt: null,
    ...overrides,
  });
}

describe('POST .../rebake-part', () => {
  it('enqueues a rebake_part job and returns it as 202, without creating a version synchronously', async () => {
    const version = await createVersion();

    const response = await rebakePart(jsonRequest({ target: 'Legs', instruction: 'darker' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id }),
    });
    expect(response.status).toBe(202);
    const { job } = (await response.json()) as { job: { id: string; kind: string; status: string } };
    expect(job.kind).toBe('rebake_part');
    expect(job.status).toBe('queued');

    const stored = await store.getJob(job.id);
    expect(stored?.input).toEqual({
      versionId: version.id,
      target: 'Legs',
      materialChange: { instruction: 'darker' },
    });

    // Nothing ran synchronously: still exactly the one version.
    expect(await store.listAssetVersions(asset.id)).toHaveLength(1);
  });

  it('resolves and passes through a libraryEntryId the caller actually owns', async () => {
    const version = await createVersion();
    const entry = await store.createMaterialLibraryEntry({
      ownerId: OWNER,
      name: 'Blackened steel',
      code: null,
      kind: 'metal',
      baseColorHex: '#1A1A1D',
      roughness: 0.4,
      metalness: 1,
      sheen: 0,
      clearcoat: 0,
      finish: 'powder-coated',
      notes: '',
      swatchPath: null,
      archivedAt: null,
    });

    const response = await rebakePart(jsonRequest({ target: 'Legs', libraryEntryId: entry.id }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id }),
    });
    expect(response.status).toBe(202);
    const { job } = (await response.json()) as { job: { id: string } };
    const stored = await store.getJob(job.id);
    expect(stored?.input.materialChange).toEqual({ libraryEntryId: entry.id });
  });

  it("404s a libraryEntryId that isn't this viewer's", async () => {
    const version = await createVersion();
    const entry = await store.createMaterialLibraryEntry({
      ownerId: 'someone-else',
      name: 'Not yours',
      code: null,
      kind: 'metal',
      baseColorHex: '#000000',
      roughness: 0.5,
      metalness: 1,
      sheen: 0,
      clearcoat: 0,
      finish: 'raw',
      notes: '',
      swatchPath: null,
      archivedAt: null,
    });

    const response = await rebakePart(jsonRequest({ target: 'Legs', libraryEntryId: entry.id }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id }),
    });
    expect(response.status).toBe(404);
  });

  it('400s without a target', async () => {
    const version = await createVersion();
    const response = await rebakePart(jsonRequest({ instruction: 'darker' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id }),
    });
    expect(response.status).toBe(400);
  });

  it('400s when neither libraryEntryId nor instruction is given', async () => {
    const version = await createVersion();
    const response = await rebakePart(jsonRequest({ target: 'Legs' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id }),
    });
    expect(response.status).toBe(400);
  });

  it('400s when both libraryEntryId and instruction are given', async () => {
    const version = await createVersion();
    const response = await rebakePart(
      jsonRequest({ target: 'Legs', libraryEntryId: 'whatever', instruction: 'darker' }),
      { params: Promise.resolve({ assetId: asset.id, versionId: version.id }) },
    );
    expect(response.status).toBe(400);
  });

  it('409s when the version has no mesh yet', async () => {
    const version = await createVersion({ meshPath: null });
    const response = await rebakePart(jsonRequest({ target: 'Legs', instruction: 'darker' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id }),
    });
    expect(response.status).toBe(409);
  });

  it('404s when the version does not belong to this asset', async () => {
    const otherAsset = await store.createAsset({
      projectId: project.id,
      name: 'Other',
      status: 'ready',
      currentVersionId: null,
      sourceImageIds: [],
    });
    const version = await createVersion({ assetId: otherAsset.id });

    const response = await rebakePart(jsonRequest({ target: 'Legs', instruction: 'darker' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id }),
    });
    expect(response.status).toBe(404);
  });

  // Unlike the material spot-fix route, an accepted parent is not a blocker:
  // rebake_part always forks a new version rather than mutating this one.
  it('still enqueues against an accepted version, same as refine', async () => {
    const version = await createVersion({ acceptedAt: new Date().toISOString() });
    const response = await rebakePart(jsonRequest({ target: 'Legs', instruction: 'darker' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id }),
    });
    expect(response.status).toBe(202);
  });
});
