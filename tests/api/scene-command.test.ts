import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { applySceneMutations, type SceneMutation } from '@/lib/scene/command';
import { createAssetNode, createSceneDoc, IDENTITY_TRANSFORM } from '@/lib/scene/defaults';
import type { AssetVersion, FurnitureAsset, Project, Scene, SceneDoc, SceneNode } from '@/lib/types';
import { makeFurnitureSpec } from '../fixtures';

/**
 * Issue #60 (interpretation) / issue #89 (the studio's own live-preview
 * step): `POST /api/scenes/:sceneId/command/interpret` turns one free-text
 * studio command into a validated `SceneMutation[]`, read-only - it neither
 * applies nor saves anything (see that route's own doc comment for why the
 * studio does the apply+save itself now, through `applySceneMutations` and
 * the ordinary scene-save path). This drives the real route handler against a
 * real on-disk LocalStore, entirely offline (no GEMINI_API_KEY in the test
 * environment), exercising `offlineInterpretSceneCommand` exactly as CI does
 * with an empty .env.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { POST: postInterpret } = await import('@/app/api/scenes/[sceneId]/command/interpret/route');

let dir: string;
let store: LocalStore;
let project: Project;
let asset: FurnitureAsset;
let version: AssetVersion;
let scene: Scene;

const OWNER = 'command-owner';

function lightNode(): SceneNode {
  return {
    id: 'light-1',
    name: 'Key Light',
    kind: 'light',
    transform: structuredClone(IDENTITY_TRANSFORM),
    visible: true,
    assetVersionId: null,
    propKind: null,
    light: { type: 'key', colorHex: '#FFFFFF', intensity: 1, distance: 5 },
    materialOverrides: {},
  };
}

function docWith(nodes: SceneNode[]): SceneDoc {
  return { ...createSceneDoc(), nodes };
}

function jsonRequest(body: unknown) {
  return new Request('http://local/api/scenes/scene/command/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function requestFor(sceneId: string, body: unknown) {
  return postInterpret(jsonRequest(body), { params: Promise.resolve({ sceneId }) });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-scene-command-'));
  store = new LocalStore(dir);
  vi.mocked(getSession).mockResolvedValue({ store, viewer: { id: OWNER, email: `${OWNER}@test` } });

  project = await store.createProject({ ownerId: OWNER, name: 'Command project' });
  asset = await store.createAsset({
    projectId: project.id,
    name: 'Sofa',
    status: 'ready',
    currentVersionId: null,
    sourceImageIds: [],
  });
  version = await store.createAssetVersion({
    assetId: asset.id,
    versionNumber: 1,
    label: 'v1',
    parentVersionId: null,
    spec: makeFurnitureSpec({ displayName: 'Sofa' }),
    views: [],
    meshPath: 'meshes/v1.glb',
    meshExtentMm: 2000,
    previewPath: null,
    provider: 'test',
    providerJobId: null,
    refinement: null,
    qaResult: null,
    previewMeshPath: null,
    acceptedAt: null,
  });

  const sofaNode = createAssetNode(version, 'Sofa', { position: { x: 1, y: 0, z: 0 } });
  scene = await store.createScene({
    projectId: project.id,
    name: 'Booth',
    doc: docWith([sofaNode, lightNode()]),
  });
});

afterEach(async () => {
  vi.mocked(getSession).mockReset();
  await rm(dir, { recursive: true, force: true });
});

describe('POST /api/scenes/[sceneId]/command/interpret', () => {
  it('interprets a move and a light warm-up in one command, offline, without saving anything', async () => {
    const response = await requestFor(scene.id, { command: 'move the sofa 30cm left and warm up the lighting' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mutations: SceneMutation[]; unresolved: string[] };

    expect(body.unresolved).toEqual([]);
    expect(body.mutations).toEqual(
      expect.arrayContaining([{ kind: 'move_node', nodeName: 'Sofa', deltaMeters: { x: -0.3, y: 0, z: 0 } }]),
    );
    const light = body.mutations.find((m) => m.kind === 'set_light_property');
    expect(light).toBeDefined();

    // Nothing was persisted - this route is read-only.
    const reread = await store.getScene(scene.id);
    expect(reread!.version).toBe(scene.version);
    expect(reread!.doc.nodes.find((n) => n.name === 'Sofa')!.transform.position).toEqual({ x: 1, y: 0, z: 0 });

    // The returned mutations apply cleanly onto the studio's own in-memory
    // doc, exactly as the command bar does client-side (issue #89).
    const applied = applySceneMutations(scene.doc, body.mutations, {});
    expect(applied.doc.nodes.find((n) => n.name === 'Sofa')!.transform.position).toEqual({ x: 0.7, y: 0, z: 0 });
    expect(applied.lastTouchedNodeId).toBeTruthy();
  });

  it('400s when no command is given', async () => {
    const response = await requestFor(scene.id, {});
    expect(response.status).toBe(400);
  });

  it('returns an empty mutation list and explains itself when nothing in the command could be understood', async () => {
    const response = await requestFor(scene.id, { command: 'juggle the sofa enthusiastically' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mutations: SceneMutation[]; unresolved: string[] };
    expect(body.mutations).toEqual([]);
    expect(body.unresolved).toEqual(['juggle the sofa enthusiastically']);
  });

  it('404s for a scene belonging to a different project owner', async () => {
    vi.mocked(getSession).mockResolvedValue({ store, viewer: { id: 'someone-else', email: 'x@test' } });
    const response = await requestFor(scene.id, { command: 'move the sofa 30cm left' });
    expect(response.status).toBe(404);
  });

  it('reports an unresolved reference to a piece not on the stage without inventing a mutation for it', async () => {
    const response = await requestFor(scene.id, { command: 'move the nonexistent-armchair 30cm left' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mutations: SceneMutation[]; unresolved: string[] };
    expect(body.mutations).toEqual([]);
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatch(/skipped/i);
  });
});
