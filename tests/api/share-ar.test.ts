import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMassingGlb } from '@/lib/ai/mesh/massing';
import { LocalStore } from '@/lib/db/local';
import type { AssetVersion, FurnitureAsset, Project, Scene } from '@/lib/types';

import { makeFurnitureSpec } from '../fixtures';

/**
 * Route-level check for `GET /api/share/[token]/ar/[assetVersionId]`, in the
 * same spirit as tests/api/authorization.test.ts: `resolveShareToken` is
 * mocked (it is `lib/share/access`'s job to validate a raw token, tested
 * separately) so this can drive the route against a real LocalStore instead
 * of the process-wide singleton `getLocalStoreForShareAccess()` binds to.
 */
vi.mock('@/lib/share/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/share/access')>();
  return { ...actual, resolveShareToken: vi.fn() };
});

const { resolveShareToken } = await import('@/lib/share/access');
const { GET } = await import('@/app/api/share/[token]/ar/[assetVersionId]/route');

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;
let version: AssetVersion;
let scene: Scene;

const EMPTY_ENVIRONMENT = {
  presetId: 'gallery',
  floorMaterialId: 'concrete',
  floorColorHex: '#ccc',
  wallColorHex: '#eee',
  boothWidth: 4,
  boothDepth: 4,
  boothHeight: 3,
  walls: { back: true, left: false, right: false },
  hdriPreset: 'studio',
  hdriIntensity: 1,
  ambientIntensity: 0.3,
  backgroundColorHex: '#fff',
  showGrid: true,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-share-ar-'));
  store = new LocalStore(dir);

  project = await store.createProject({ ownerId: 'owner-1', name: 'Test project' });
  asset = await store.createAsset({
    projectId: project.id,
    name: 'Chair',
    status: 'ready',
    currentVersionId: null,
    sourceImageIds: [],
  });

  const spec = makeFurnitureSpec();
  const glb = buildMassingGlb(spec);
  const meshPath = `${project.id}/assets/${asset.id}/mesh.glb`;
  await store.putBlob(meshPath, glb, 'model/gltf-binary');

  version = await store.createAssetVersion({
    assetId: asset.id,
    versionNumber: 1,
    label: 'v1',
    parentVersionId: null,
    spec,
    views: [],
    meshPath,
    meshExtentMm: Math.max(spec.dimensions.widthMm, spec.dimensions.depthMm, spec.dimensions.heightMm),
    previewPath: null,
    provider: 'stub',
    providerJobId: null,
    refinement: null,
    acceptedAt: null,
  });

  scene = await store.createScene({
    projectId: project.id,
    name: 'Booth',
    doc: {
      schemaVersion: 1,
      environment: EMPTY_ENVIRONMENT,
      camera: { position: { x: 0, y: 1.6, z: 3 }, target: { x: 0, y: 1, z: 0 }, fov: 40 },
      nodes: [
        {
          id: 'node-1',
          name: 'Chair',
          kind: 'asset',
          transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
          visible: true,
          assetVersionId: version.id,
          propKind: null,
          light: null,
          materialOverrides: {},
        },
      ],
    },
  });

  vi.mocked(resolveShareToken).mockReset();
  vi.mocked(resolveShareToken).mockResolvedValue({ ok: true, context: { store, scene } });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function getRequest(token: string, assetVersionId: string) {
  return GET(new Request(`http://test/api/share/${token}/ar/${assetVersionId}`), {
    params: Promise.resolve({ token, assetVersionId }),
  });
}

describe('GET /api/share/[token]/ar/[assetVersionId]', () => {
  it('serves a scaled, grounded, valid GLB for a version the shared scene stages', async () => {
    const response = await getRequest('tok', version.id);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('model/gltf-binary');

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);

    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const document = await io.readBinary(bytes);
    const parsedScene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
    expect(parsedScene).toBeDefined();

    const { min } = getBounds(parsedScene!);
    expect(min[1]).toBeCloseTo(0, 3);
  });

  it('404s for an asset version the shared scene does not reference', async () => {
    const otherAsset = await store.createAsset({
      projectId: project.id,
      name: 'Other',
      status: 'ready',
      currentVersionId: null,
      sourceImageIds: [],
    });
    const spec = makeFurnitureSpec();
    const otherVersion = await store.createAssetVersion({
      assetId: otherAsset.id,
      versionNumber: 1,
      label: 'v1',
      parentVersionId: null,
      spec,
      views: [],
      meshPath: null,
      meshExtentMm: null,
      previewPath: null,
      provider: 'stub',
      providerJobId: null,
      refinement: null,
      acceptedAt: null,
    });

    const response = await getRequest('tok', otherVersion.id);
    expect(response.status).toBe(404);
  });

  it('404s for a version id that does not exist at all', async () => {
    const response = await getRequest('tok', '00000000-0000-0000-0000-000000000000');
    expect(response.status).toBe(404);
  });

  it('propagates an invalid/expired token as the same failure resolveShareToken reports', async () => {
    vi.mocked(resolveShareToken).mockResolvedValue({
      ok: false,
      status: 410,
      message: 'This share link has expired',
    });

    const response = await getRequest('expired-token', version.id);
    expect(response.status).toBe(410);
  });
});
