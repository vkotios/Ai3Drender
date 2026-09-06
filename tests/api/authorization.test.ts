import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import type { FurnitureAsset, Project, Scene } from '@/lib/types';

/**
 * `withAsset`/`withScene` (lib/api.ts) walk ownership back to the project by
 * hand - the store itself does not re-check it - so this is the one place a
 * cross-project id could slip through. `getSession` is mocked per test so we
 * can simulate "a different owner is signed in" while `requireProject`
 * (the real implementation) does the actual ownership check against a real
 * LocalStore.
 */
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getSession: vi.fn() };
});

const { getSession } = await import('@/lib/db');
const { withAsset, withScene, withProject } = await import('@/lib/api');

let dir: string;
let store: LocalStore;
let ownerAProject: Project;
let ownerBProject: Project;
let ownerAAsset: FurnitureAsset;
let ownerAScene: Scene;

const sessionFor = (viewerId: string) => ({ store, viewer: { id: viewerId, email: `${viewerId}@test` } });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-authz-'));
  store = new LocalStore(dir);

  ownerAProject = await store.createProject({ ownerId: 'owner-a', name: "Owner A's project" });
  ownerBProject = await store.createProject({ ownerId: 'owner-b', name: "Owner B's project" });

  ownerAAsset = await store.createAsset({
    projectId: ownerAProject.id,
    name: 'Chair',
    status: 'draft',
    currentVersionId: null,
    sourceImageIds: [],
  });

  ownerAScene = await store.createScene({
    projectId: ownerAProject.id,
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
      nodes: [],
    },
  });

  vi.mocked(getSession).mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const okHandler = vi.fn(async () => NextResponse.json({ ok: true }));

describe('withAsset', () => {
  it('denies a request for an asset belonging to a different project owner', async () => {
    okHandler.mockClear();
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-b'));

    const response = await withAsset(ownerAAsset.id, okHandler);

    expect(response.status).toBe(404);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('allows the actual owner through', async () => {
    okHandler.mockClear();
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-a'));

    const response = await withAsset(ownerAAsset.id, okHandler);

    expect(response.status).toBe(200);
    expect(okHandler).toHaveBeenCalledTimes(1);
  });

  it('404s for an asset id that does not exist at all, the same as a cross-project one', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-a'));
    const response = await withAsset('00000000-0000-0000-0000-000000000000', okHandler);
    expect(response.status).toBe(404);
  });
});

describe('withScene', () => {
  it('denies a request for a scene belonging to a different project owner', async () => {
    okHandler.mockClear();
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-b'));

    const response = await withScene(ownerAScene.id, okHandler);

    expect(response.status).toBe(404);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it('allows the actual owner through', async () => {
    okHandler.mockClear();
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-a'));

    const response = await withScene(ownerAScene.id, okHandler);

    expect(response.status).toBe(200);
    expect(okHandler).toHaveBeenCalledTimes(1);
  });
});

describe('withProject', () => {
  it('allows a different owner through for a project they DO own', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-b'));
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));

    const response = await withProject(ownerBProject.id, handler);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("denies a request for another owner's project directly", async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-b'));
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));

    const response = await withProject(ownerAProject.id, handler);

    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects with 401 when nobody is signed in', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));

    const response = await withProject(ownerAProject.id, handler);

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not leak whether the project exists vs. belongs to someone else (both are a plain 404)', async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor('owner-b'));
    const nonExistent = await withProject('00000000-0000-0000-0000-000000000000', okHandler);
    const crossOwner = await withProject(ownerAProject.id, okHandler);
    expect(nonExistent.status).toBe(crossOwner.status);
  });
});
