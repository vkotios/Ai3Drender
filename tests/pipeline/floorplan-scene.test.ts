import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { drainJobs } from '@/lib/pipeline';
import type { Job, Project } from '@/lib/types';
import { makeFurnitureSpec } from '../fixtures';

/**
 * Exercises the whole `floorplan_scene` job (issue #58) against a real
 * on-disk LocalStore, offline/stub mode (GEMINI_API_KEY unset - see
 * tests/setup.ts), the same way tests/pipeline/pipeline.test.ts drives
 * analyze -> synthesize_views -> reconstruct.
 */

let dir: string;
let store: LocalStore;
let project: Project;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-floorplan-scene-'));
  store = new LocalStore(dir);
  project = await store.createProject({ ownerId: 'owner-1', name: 'Test project' });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function drainAll(max = 20) {
  let total = 0;
  for (let i = 0; i < max; i += 1) {
    const processed = await drainJobs(store, 1);
    total += processed;
    if (processed === 0) break;
  }
  return total;
}

describe('pipeline: floorplan_scene', () => {
  it('builds a whole new, populated stand from an uploaded floor-plan image, offline', async () => {
    const floorPlanPath = `${project.id}/floorplans/plan.png`;
    await store.putBlob(floorPlanPath, new Uint8Array([1, 2, 3, 4]), 'image/png');

    const job = await store.createJob({
      projectId: project.id,
      kind: 'floorplan_scene',
      input: { floorPlanPath, imageWidthPx: 1600, imageHeightPx: 1200, sceneName: 'From my floor plan' },
    });

    await drainAll();

    const finished = await store.getJob(job.id);
    expect(finished!.status).toBe('succeeded');
    expect(finished!.output).toMatchObject({ source: 'offline' });

    const sceneId = (finished!.output as { sceneId: string }).sceneId;
    const scene = await store.getScene(sceneId);
    expect(scene).not.toBeNull();
    expect(scene!.projectId).toBe(project.id);
    expect(scene!.name).toBe('From my floor plan');

    const footprint = scene!.doc.environment.footprint;
    expect(footprint?.boundary.length).toBeGreaterThanOrEqual(3);
    expect(footprint?.walls).toHaveLength(footprint!.boundary.length);
    expect(footprint?.underlay).toMatchObject({ imagePath: floorPlanPath });

    // The offline stub places a couple of placeholder props - never an
    // asset, since it never sees the image well enough to match one.
    expect(scene!.doc.nodes.length).toBeGreaterThan(0);
    expect(scene!.doc.nodes.every((n) => n.kind === 'prop')).toBe(true);
  });

  it('only offers "ready" assets (with a current version) as placement candidates - never one still reconstructing', async () => {
    // Sets up an asset that would be eligible, and one that would not,
    // purely to prove the job tolerates both without throwing - the offline
    // stub itself never actually stages an asset (see the test above).
    const readyAsset = await store.createAsset({
      projectId: project.id,
      name: 'Sofa',
      status: 'ready',
      currentVersionId: null,
      sourceImageIds: [],
    });
    const version = await store.createAssetVersion({
      assetId: readyAsset.id,
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
    await store.updateAsset(readyAsset.id, { currentVersionId: version.id });
    await store.createAsset({
      projectId: project.id,
      name: 'Still reconstructing',
      status: 'reconstructing',
      currentVersionId: null,
      sourceImageIds: [],
    });

    const floorPlanPath = `${project.id}/floorplans/plan2.png`;
    await store.putBlob(floorPlanPath, new Uint8Array([1, 2, 3, 4]), 'image/png');
    await store.createJob({
      projectId: project.id,
      kind: 'floorplan_scene',
      input: { floorPlanPath, imageWidthPx: 1000, imageHeightPx: 1000 },
    });

    await drainAll();

    const jobs: Job[] = await store.listJobs(project.id);
    const done = jobs.find((j) => j.kind === 'floorplan_scene')!;
    expect(done.status).toBe('succeeded');
  });

  it('fails cleanly when the referenced floor-plan blob is missing', async () => {
    const job = await store.createJob({
      projectId: project.id,
      kind: 'floorplan_scene',
      input: { floorPlanPath: `${project.id}/floorplans/missing.png`, imageWidthPx: 800, imageHeightPx: 600 },
    });

    await drainAll();

    const finished = await store.getJob(job.id);
    expect(finished!.status).toBe('failed');
    expect(finished!.error).toMatch(/missing/i);
  });
});
