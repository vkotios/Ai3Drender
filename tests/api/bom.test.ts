import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import type { AssetVersion, FurnitureAsset, MaterialLibraryEntry, Project } from '@/lib/types';
import { makeComponent, makeFurnitureSpec, makeMaterial } from '../fixtures';

/**
 * End-to-end over a real LocalStore: create an asset version with a spec that
 * mirrors what the vision pass produces, rebind one material to a library
 * entry (the same PATCH route issue #15 added), accept the version, then hit
 * the BOM route directly and parse the CSV it returns.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { GET } = await import('@/app/api/assets/[assetId]/versions/[versionId]/bom/route');
const { PATCH: rebindMaterial } = await import(
  '@/app/api/assets/[assetId]/versions/[versionId]/materials/[materialId]/route'
);

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;
let libraryEntry: MaterialLibraryEntry;

const OWNER = 'owner-a';
const sessionFor = (viewerId: string) => ({ store, viewer: { id: viewerId, email: `${viewerId}@test` } });

async function buildParams(assetId: string, versionId: string) {
  return { params: Promise.resolve({ assetId, versionId }) };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-bom-'));
  store = new LocalStore(dir);

  project = await store.createProject({ ownerId: OWNER, name: 'Showroom' });
  asset = await store.createAsset({
    projectId: project.id,
    name: 'Lounge Chair',
    status: 'ready',
    currentVersionId: null,
    sourceImageIds: [],
  });
  libraryEntry = await store.createMaterialLibraryEntry({
    ownerId: OWNER,
    name: 'Solid Oak',
    code: 'OAK-014',
    kind: 'wood',
    baseColorHex: '#8B5A2B',
    roughness: 0.55,
    metalness: 0,
    sheen: 0,
    clearcoat: 0.25,
    finish: 'oiled',
    notes: '',
    swatchPath: null,
    archivedAt: null,
  });

  vi.mocked(getSession).mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Parse the small, RFC-4180-shaped CSV this endpoint produces back into rows. */
function parseCsv(csv: string): string[][] {
  return csv
    .trim()
    .split('\r\n')
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '')));
}

describe('GET /api/assets/:assetId/versions/:versionId/bom', () => {
  async function createDraftVersion(): Promise<AssetVersion> {
    const spec = makeFurnitureSpec({
      displayName: 'Lounge Chair',
      components: [
        makeComponent({ name: 'Legs', role: 'leg', materialId: 'frame' }),
        makeComponent({ name: 'Seat', role: 'seat', materialId: 'upholstery' }),
        makeComponent({ name: 'Arms', role: 'armrest', materialId: 'frame' }),
      ],
      materials: [
        makeMaterial({ id: 'frame', name: 'Timber frame', kind: 'wood' }),
        makeMaterial({
          id: 'upholstery',
          name: 'Wool blend',
          kind: 'fabric',
          invented: true,
          libraryEntryId: null,
        }),
      ],
    });

    return store.createAssetVersion({
      assetId: asset.id,
      versionNumber: 1,
      label: 'v1',
      parentVersionId: null,
      spec,
      views: [],
      meshPath: 'projects/x/mesh.glb',
      meshExtentMm: 900,
      previewPath: null,
      provider: 'stub',
      providerJobId: null,
      refinement: null,
      qaResult: null,
      previewMeshPath: null,
      acceptedAt: null,
    });
  }

  it('refuses to export a version that has not been accepted yet', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor(OWNER));
    const version = await createDraftVersion();

    const response = await GET(new Request('http://test/bom'), await buildParams(asset.id, version.id));
    expect(response.status).toBe(409);
  });

  it('lists components with bound codes, unbound flags and instance counts for an accepted version', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor(OWNER));
    const draft = await createDraftVersion();

    // Bind "frame" to the library entry before accepting - rebinding an
    // accepted version is refused, same as any other spec edit.
    const rebindResponse = await rebindMaterial(
      new Request('http://test/materials/frame', {
        method: 'PATCH',
        body: JSON.stringify({ libraryEntryId: libraryEntry.id }),
      }),
      { params: Promise.resolve({ assetId: asset.id, versionId: draft.id, materialId: 'frame' }) },
    );
    expect(rebindResponse.status).toBe(200);

    const acceptResponse = await store.updateAssetVersion(draft.id, { acceptedAt: new Date().toISOString() });
    expect(acceptResponse.acceptedAt).not.toBeNull();

    const response = await GET(new Request('http://test/bom'), await buildParams(asset.id, draft.id));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain('lounge-chair-v1-bom.csv');

    const csv = await response.text();
    const [header, ...rows] = parseCsv(csv);
    expect(header).toEqual(['Component', 'Role', 'Quantity', 'Material', 'Code']);

    const byComponent = Object.fromEntries(rows.map((r) => [r[0], r]));

    // "Legs" is role 'leg', which the massing generator (and therefore the
    // whole-part annotation selection) always expands to 4 instances.
    expect(byComponent['Legs']).toEqual(['Legs', 'leg', '4', 'Solid Oak', 'OAK-014']);
    // "Arms" shares the same rebound "frame" material as "Legs", but is role
    // 'armrest' -> 2 instances, unrelated to Legs' count of 4.
    expect(byComponent['Arms']).toEqual(['Arms', 'armrest', '2', 'Solid Oak', 'OAK-014']);
    // "Seat" was never bound to the library - flagged, not silently blank.
    expect(byComponent['Seat']).toEqual(['Seat', 'seat', '1', 'invented — no library match', '']);
  });

  it('404s for a version that does not belong to the given asset', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor(OWNER));
    const otherAsset = await store.createAsset({
      projectId: project.id,
      name: 'Other',
      status: 'ready',
      currentVersionId: null,
      sourceImageIds: [],
    });
    const version = await createDraftVersion();
    await store.updateAssetVersion(version.id, { acceptedAt: new Date().toISOString() });

    const response = await GET(new Request('http://test/bom'), await buildParams(otherAsset.id, version.id));
    expect(response.status).toBe(404);
  });

  it("denies a caller who does not own the asset's project", async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-b'));
    const version = await createDraftVersion();
    await store.updateAssetVersion(version.id, { acceptedAt: new Date().toISOString() });

    const response = await GET(new Request('http://test/bom'), await buildParams(asset.id, version.id));
    expect(response.status).toBe(404);
  });
});
