import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import type { AssetVersion, FurnitureAsset, Project } from '@/lib/types';
import { makeComponent, makeFurnitureSpec, makeMaterial } from '../fixtures';

/**
 * Issue #48: the material rebind route also accepts a free-text `instruction`
 * ("make this darker walnut") that spot-fixes one material's PBR values
 * without touching the rest of the spec or the mesh - the lighter
 * alternative to a full refine round. This runs entirely offline (no
 * GEMINI_API_KEY in the test environment), exercising `offlineMaterialCorrection`
 * exactly as CI does with an empty .env, and drives the real route handlers
 * against a real on-disk LocalStore rather than re-implementing their logic.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { PATCH: rebindMaterial } = await import(
  '@/app/api/assets/[assetId]/versions/[versionId]/materials/[materialId]/route'
);
const { GET: getAsset } = await import('@/app/api/assets/[assetId]/route');

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;

const OWNER = 'spot-fix-owner';

const jsonRequest = (body: unknown) =>
  new Request('http://local/api/materials/spot-fix', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-spot-fix-'));
  store = new LocalStore(dir);
  vi.mocked(getSession).mockResolvedValue({ store, viewer: { id: OWNER, email: `${OWNER}@test` } });

  project = await store.createProject({ ownerId: OWNER, name: 'Spot-fix project' });
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

/** A spec with two distinct materials, so a spot-fix on one can be proven not to touch the other. */
async function createVersion(overrides: Partial<AssetVersion> = {}): Promise<AssetVersion> {
  const frame = makeMaterial({ id: 'frame', name: 'Solid timber frame' });
  const accent = makeMaterial({
    id: 'accent',
    name: 'Blackened steel accent',
    kind: 'metal',
    baseColorHex: '#2A2A2D',
    roughness: 0.42,
    metalness: 1,
    clearcoat: 0,
    finish: 'powder-coated',
  });

  const spec = makeFurnitureSpec({
    materials: [frame, accent],
    components: [
      makeComponent({ name: 'Legs', role: 'leg', materialId: 'frame' }),
      makeComponent({ name: 'Bracket', role: 'frame', materialId: 'accent' }),
    ],
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

describe('PATCH .../materials/:materialId with a free-text instruction', () => {
  it('spot-fixes only the targeted material, offline, and persists (checked via a separate GET)', async () => {
    const version = await createVersion();

    const response = await rebindMaterial(jsonRequest({ instruction: 'make this darker walnut' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id, materialId: 'frame' }),
    });
    expect(response.status).toBe(200);
    const written = (await response.json()) as AssetVersion;

    const writtenFrame = written.spec.materials.find((m) => m.id === 'frame')!;
    const writtenAccent = written.spec.materials.find((m) => m.id === 'accent')!;

    // The targeted material actually changed...
    expect(writtenFrame.baseColorHex).not.toBe('#8B5A2B');
    expect(writtenFrame.notes).toMatch(/spot-fixed offline/i);
    expect(writtenFrame.notes).toMatch(/darker walnut/i);
    // ...diverges from any library entry now, so it is unbound and flagged invented,
    // exactly like a vision pass that couldn't match a surface against the library.
    expect(writtenFrame.libraryEntryId).toBeNull();
    expect(writtenFrame.invented).toBe(true);
    // Identity fields the correction has no business touching are untouched.
    expect(writtenFrame.id).toBe('frame');
    expect(writtenFrame.name).toBe('Solid timber frame');
    expect(writtenFrame.kind).toBe('wood');

    // ...and nothing else about the spec moved.
    expect(writtenAccent).toEqual(makeMaterial({
      id: 'accent',
      name: 'Blackened steel accent',
      kind: 'metal',
      baseColorHex: '#2A2A2D',
      roughness: 0.42,
      metalness: 1,
      clearcoat: 0,
      finish: 'powder-coated',
    }));
    expect(written.spec.components).toEqual(version.spec.components);
    expect(written.spec.dimensions).toEqual(version.spec.dimensions);
    expect(written.spec.displayName).toBe(version.spec.displayName);
    expect(written.meshPath).toBe(version.meshPath);
    expect(written.meshExtentMm).toBe(version.meshExtentMm);

    // Re-read through a completely separate request/handler, not the write's own
    // response, to prove the change actually persisted rather than only being echoed.
    const read = await getAsset(new Request(`http://local/api/assets/${asset.id}`), {
      params: Promise.resolve({ assetId: asset.id }),
    });
    expect(read.status).toBe(200);
    const { versions } = (await read.json()) as { versions: { version: AssetVersion }[] };
    const reread = versions.find((v) => v.version.id === version.id)!.version;

    const rereadFrame = reread.spec.materials.find((m) => m.id === 'frame')!;
    const rereadAccent = reread.spec.materials.find((m) => m.id === 'accent')!;
    expect(rereadFrame).toEqual(writtenFrame);
    expect(rereadAccent).toEqual(writtenAccent);
    expect(reread.spec.components).toEqual(version.spec.components);
  });

  it('is deterministic: the same material and instruction always produce the same correction', async () => {
    const v1 = await createVersion();
    const v2 = await createVersion();

    const r1 = await rebindMaterial(jsonRequest({ instruction: 'make this darker walnut' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: v1.id, materialId: 'frame' }),
    });
    const r2 = await rebindMaterial(jsonRequest({ instruction: 'make this darker walnut' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: v2.id, materialId: 'frame' }),
    });

    const f1 = ((await r1.json()) as AssetVersion).spec.materials.find((m) => m.id === 'frame');
    const f2 = ((await r2.json()) as AssetVersion).spec.materials.find((m) => m.id === 'frame');
    expect(f1).toEqual(f2);
  });

  it('still changes the material for an instruction with no recognised keyword', async () => {
    const version = await createVersion();
    const response = await rebindMaterial(jsonRequest({ instruction: 'make it pop a bit more' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id, materialId: 'frame' }),
    });
    const updated = (await response.json()) as AssetVersion;
    const frame = updated.spec.materials.find((m) => m.id === 'frame')!;
    expect(frame).not.toEqual(makeMaterial({ id: 'frame', name: 'Solid timber frame' }));
  });

  it('404s when the material id does not exist on this version', async () => {
    const version = await createVersion();
    const response = await rebindMaterial(jsonRequest({ instruction: 'darker' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id, materialId: 'nonexistent' }),
    });
    expect(response.status).toBe(404);
  });

  it('400s when neither libraryEntryId nor instruction is given', async () => {
    const version = await createVersion();
    const response = await rebindMaterial(jsonRequest({}), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id, materialId: 'frame' }),
    });
    expect(response.status).toBe(400);
  });

  it('respects the accepted-version-immutability guard, same as the libraryEntryId path', async () => {
    const version = await createVersion();
    await store.updateAssetVersion(version.id, { acceptedAt: new Date().toISOString() });

    const response = await rebindMaterial(jsonRequest({ instruction: 'make this darker walnut' }), {
      params: Promise.resolve({ assetId: asset.id, versionId: version.id, materialId: 'frame' }),
    });
    expect(response.status).toBe(409);

    // Confirm via a separate read that nothing was written.
    const reread = await store.getAssetVersion(version.id);
    expect(reread!.spec.materials.find((m) => m.id === 'frame')).toEqual(
      makeMaterial({ id: 'frame', name: 'Solid timber frame' }),
    );
  });
});
