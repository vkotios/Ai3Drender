import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import type { AssetVersion, FurnitureAsset, Project, Scene } from '@/lib/types';
import { makeFurnitureSpec } from '../fixtures';

/**
 * Issue #39: a 'viewer' share link may look at a scene but must never be able
 * to write through it - not because the UI hides the controls (it does, see
 * ShareStudioShell), but because the write routes reject it themselves. This
 * exercises those routes directly against a real LocalStore, the same way
 * tests/api/authorization.test.ts exercises withAsset/withScene: the share
 * routes reach the process-wide LocalStore through
 * `getLocalStoreForShareAccess`, so that is the one seam mocked here to point
 * at a disposable per-test store instead.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getLocalStoreForShareAccess: () => store };
});

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;
let version: AssetVersion;
let scene: Scene;
let commenterToken: string;
let viewerToken: string;

const { POST: postAnnotation } = await import('@/app/api/share/[token]/annotations/route');
const { POST: postReview } = await import('@/app/api/share/[token]/review/route');
const { GET: getShareView } = await import('@/app/api/share/[token]/route');

function request(body: unknown) {
  return new Request('http://localhost/api/share/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-share-role-'));
  store = new LocalStore(dir);

  project = await store.createProject({ ownerId: 'owner-share', name: "Owner's project" });
  asset = await store.createAsset({
    projectId: project.id,
    name: 'Chair',
    status: 'draft',
    currentVersionId: null,
    sourceImageIds: [],
  });
  version = await store.createAssetVersion({
    assetId: asset.id,
    versionNumber: 1,
    label: 'v1',
    parentVersionId: null,
    spec: makeFurnitureSpec(),
    views: [],
    meshPath: null,
    previewPath: null,
    meshExtentMm: null,
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

  ({ token: commenterToken } = await store.createShareLink({
    sceneId: scene.id,
    createdBy: 'owner-share',
    role: 'commenter',
  }));
  ({ token: viewerToken } = await store.createShareLink({
    sceneId: scene.id,
    createdBy: 'owner-share',
    role: 'viewer',
  }));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/share/[token]', () => {
  it('lets both a commenter and a viewer link view the scene, and reports the resolved role', async () => {
    const commenterResponse = await getShareView(new Request('http://localhost/api/share/x'), {
      params: Promise.resolve({ token: commenterToken }),
    });
    expect(commenterResponse.status).toBe(200);
    expect((await commenterResponse.json()).role).toBe('commenter');

    const viewerResponse = await getShareView(new Request('http://localhost/api/share/x'), {
      params: Promise.resolve({ token: viewerToken }),
    });
    expect(viewerResponse.status).toBe(200);
    expect((await viewerResponse.json()).role).toBe('viewer');
  });
});

describe('POST /api/share/[token]/annotations', () => {
  const pinBody = {
    clientName: 'Jane',
    body: 'This leg looks too thick',
    point: { x: 0, y: 0.2, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    partName: 'Legs',
    assetVersionId: '',
  };

  it('lets a commenter-role token pin a note', async () => {
    const response = await postAnnotation(request({ ...pinBody, assetVersionId: version.id }), {
      params: Promise.resolve({ token: commenterToken }),
    });
    expect(response.status).toBe(201);
    const annotations = await store.listAnnotations([asset.id]);
    expect(annotations).toHaveLength(1);
  });

  it('rejects a viewer-role token with 403, and creates no annotation', async () => {
    const response = await postAnnotation(request({ ...pinBody, assetVersionId: version.id }), {
      params: Promise.resolve({ token: viewerToken }),
    });
    expect(response.status).toBe(403);
    const annotations = await store.listAnnotations([asset.id]);
    expect(annotations).toHaveLength(0);
  });
});

describe('POST /api/share/[token]/review', () => {
  const reviewBody = { status: 'approved' as const, reviewerName: 'Jane', note: 'Looks great' };

  it('lets a commenter-role token set the approval verdict', async () => {
    const response = await postReview(request(reviewBody), {
      params: Promise.resolve({ token: commenterToken }),
    });
    expect(response.status).toBe(200);
    const updated = await store.getScene(scene.id);
    expect(updated?.clientApproval).toBe('approved');
  });

  it('rejects a viewer-role token with 403, and leaves the approval untouched', async () => {
    const response = await postReview(request(reviewBody), {
      params: Promise.resolve({ token: viewerToken }),
    });
    expect(response.status).toBe(403);
    const updated = await store.getScene(scene.id);
    expect(updated?.clientApproval).toBe('pending');
  });
});
