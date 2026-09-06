import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { createAssetNode, createSceneDoc, IDENTITY_TRANSFORM } from '@/lib/scene/defaults';
import type { AssetVersion, FurnitureAsset, Project, Scene, SceneDoc, SceneNode } from '@/lib/types';
import { makeFurnitureSpec } from '../fixtures';

/**
 * Issue #60: `POST /api/scenes/:sceneId/command` turns one free-text studio
 * command into a small set of mutations and saves them through the ordinary
 * scene-save path - so this drives the real route handler against a real
 * on-disk LocalStore, entirely offline (no GEMINI_API_KEY in the test
 * environment), exercising `offlineInterpretSceneCommand` exactly as CI does
 * with an empty .env.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { POST: postCommand } = await import('@/app/api/scenes/[sceneId]/command/route');

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
  return new Request('http://local/api/scenes/scene/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function requestFor(sceneId: string, body: unknown) {
  return postCommand(jsonRequest(body), { params: Promise.resolve({ sceneId }) });
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

describe('POST /api/scenes/[sceneId]/command', () => {
  it('applies a move and a light warm-up in one command, offline, and persists (checked via a separate read)', async () => {
    const response = await requestFor(scene.id, {
      command: 'move the sofa 30cm left and warm up the lighting',
      expectedVersion: scene.version,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scene: Scene; summary: string; unresolved: string[] };

    expect(body.unresolved).toEqual([]);
    expect(body.summary).toMatch(/Moved Sofa/);
    expect(body.scene.version).toBe(scene.version + 1);

    const sofa = body.scene.doc.nodes.find((n) => n.name === 'Sofa')!;
    expect(sofa.transform.position).toEqual({ x: 0.7, y: 0, z: 0 });
    const light = body.scene.doc.nodes.find((n) => n.name === 'Key Light')!;
    expect(light.light!.colorHex).not.toBe('#FFFFFF');

    // Re-read independently of the write's own response.
    const reread = await store.getScene(scene.id);
    expect(reread!.doc.nodes.find((n) => n.name === 'Sofa')!.transform.position).toEqual({ x: 0.7, y: 0, z: 0 });
    expect(reread!.version).toBe(scene.version + 1);
  });

  it('400s when no command is given', async () => {
    const response = await requestFor(scene.id, {});
    expect(response.status).toBe(400);
  });

  it('leaves the scene untouched and explains itself when nothing in the command could be applied', async () => {
    const response = await requestFor(scene.id, {
      command: 'juggle the sofa enthusiastically',
      expectedVersion: scene.version,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scene: Scene; summary: string; unresolved: string[] };
    expect(body.summary).toMatch(/nothing.*could be applied/i);
    expect(body.unresolved).toEqual(['juggle the sofa enthusiastically']);
    expect(body.scene.version).toBe(scene.version);

    const reread = await store.getScene(scene.id);
    expect(reread!.version).toBe(scene.version);
  });

  it('409s with the current scene when expectedVersion is stale, without applying the command', async () => {
    // Someone else saves in between.
    await store.updateScene(scene.id, { doc: docWith([...scene.doc.nodes]) }, 'someone else');

    const response = await requestFor(scene.id, {
      command: 'move the sofa 30cm left',
      expectedVersion: scene.version, // now stale
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; current: Scene };
    expect(body.error).toMatch(/someone else saved/i);
    expect(body.current.version).toBe(scene.version + 1);

    // Confirm nothing from the rejected command was written.
    const reread = await store.getScene(scene.id);
    expect(reread!.doc.nodes.find((n) => n.name === 'Sofa')!.transform.position).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('404s for a scene belonging to a different project owner', async () => {
    vi.mocked(getSession).mockResolvedValue({ store, viewer: { id: 'someone-else', email: 'x@test' } });
    const response = await requestFor(scene.id, { command: 'move the sofa 30cm left' });
    expect(response.status).toBe(404);
  });

  it('reports an unresolved reference to a piece not on the stage without touching anything else', async () => {
    const response = await requestFor(scene.id, {
      command: 'move the nonexistent-armchair 30cm left',
      expectedVersion: scene.version,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scene: Scene; summary: string; unresolved: string[] };
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatch(/skipped/i);
    expect(body.scene.version).toBe(scene.version);
  });
});
