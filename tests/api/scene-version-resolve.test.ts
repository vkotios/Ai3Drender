import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { makeFurnitureSpec } from '../fixtures';
import type { AssetVersion, FurnitureAsset, Project, Scene, SceneDoc } from '@/lib/types';

/**
 * `GET /api/scenes/[sceneId]/versions/[versionNumber]/resolve` is what the
 * side-by-side scene-version compare view (issue #42) fetches for each pane:
 * one retained save's `doc`, plus a fetchable mesh URL for every asset
 * version it references - which may be an older version than whatever the
 * live scene (and the studio's already-loaded versions map) currently points
 * at, so this has to resolve independently rather than reuse either.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { GET } = await import('@/app/api/scenes/[sceneId]/versions/[versionNumber]/resolve/route');

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;
let versionOne: AssetVersion;
let versionTwo: AssetVersion;
let scene: Scene;

function docWithNode(node: Scene['doc']['nodes'][number]): SceneDoc {
  return {
    schemaVersion: 1,
    environment: {
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
    },
    camera: { position: { x: 0, y: 1.6, z: 3 }, target: { x: 0, y: 1, z: 0 }, fov: 40 },
    nodes: [node],
  };
}

function assetNode(assetVersionId: string) {
  return {
    id: 'node-1',
    name: 'Chair',
    kind: 'asset' as const,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    visible: true,
    assetVersionId,
    propKind: null,
    light: null,
    materialOverrides: {},
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-resolve-'));
  store = new LocalStore(dir);
  vi.mocked(getSession).mockReset();

  project = await store.createProject({ ownerId: 'owner-a', name: 'A project' });
  asset = await store.createAsset({
    projectId: project.id,
    name: 'Chair',
    status: 'ready',
    currentVersionId: null,
    sourceImageIds: [],
  });

  versionOne = await store.createAssetVersion({
    assetId: asset.id,
    versionNumber: 1,
    label: 'v1',
    parentVersionId: null,
    spec: makeFurnitureSpec(),
    views: [],
    meshPath: 'meshes/v1.glb',
    meshExtentMm: null,
    previewPath: null,
    provider: 'test',
    providerJobId: null,
    refinement: null,
    qaResult: null,
    previewMeshPath: null,
    acceptedAt: null,
  });

  versionTwo = await store.createAssetVersion({
    assetId: asset.id,
    versionNumber: 2,
    label: 'v2',
    parentVersionId: versionOne.id,
    spec: makeFurnitureSpec({ displayName: 'Wider Chair' }),
    views: [],
    meshPath: 'meshes/v2.glb',
    meshExtentMm: null,
    previewPath: null,
    provider: 'test',
    providerJobId: null,
    refinement: null,
    qaResult: null,
    previewMeshPath: null,
    acceptedAt: null,
  });

  // Save #1 stages v1, then save #2 restages the same node onto v2 - so the
  // two retained saves reference two different asset versions, the way two
  // rounds of refinement actually would.
  scene = await store.createScene({
    projectId: project.id,
    name: 'Booth',
    doc: docWithNode(assetNode(versionOne.id)),
  });
  scene = await store.updateScene(scene.id, { doc: docWithNode(assetNode(versionTwo.id)) }, 'staged v2');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sessionFor = (viewerId: string) => ({ store, viewer: { id: viewerId, email: `${viewerId}@test` } });

function requestFor(sceneId: string, versionNumber: string) {
  return GET({} as Request, { params: Promise.resolve({ sceneId, versionNumber }) });
}

describe('GET /api/scenes/[sceneId]/versions/[versionNumber]/resolve', () => {
  it('resolves the older save with a mesh URL for the version IT references, not the current one', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-a'));

    const response = await requestFor(scene.id, '1');
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.sceneVersion.versionNumber).toBe(1);
    expect(body.sceneVersion.doc.nodes[0].assetVersionId).toBe(versionOne.id);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].version.id).toBe(versionOne.id);
    expect(body.versions[0].meshUrl).toBeTruthy();
  });

  it('resolves the newer save against the other version', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-a'));

    const response = await requestFor(scene.id, '2');
    const body = await response.json();

    expect(body.sceneVersion.versionNumber).toBe(2);
    expect(body.versions[0].version.id).toBe(versionTwo.id);
  });

  it('404s for a version number that was never saved', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-a'));
    const response = await requestFor(scene.id, '99');
    expect(response.status).toBe(404);
  });

  it('400s for a non-numeric version number', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-a'));
    const response = await requestFor(scene.id, 'not-a-number');
    expect(response.status).toBe(400);
  });

  it('denies a request for a scene belonging to a different project owner', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-b'));
    const response = await requestFor(scene.id, '1');
    expect(response.status).toBe(404);
  });
});
