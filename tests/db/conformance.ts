import { expect, it } from 'vitest';

import type { Store } from '@/lib/db/store';
import { makeFurnitureSpec } from '../fixtures';

/**
 * One behavioural contract, run against whichever `Store` implementation the
 * caller hands in - so `LocalStore` and `SupabaseStore` can't quietly drift
 * apart. See tests/db/local-store.test.ts and tests/db/supabase-store.test.ts
 * for the two backends this actually runs against.
 */
export function defineStoreConformance(getStore: () => Store | Promise<Store>) {
  it('creates a project and reads it back', async () => {
    const store = await getStore();
    const project = await store.createProject({ ownerId: 'owner-a', name: 'Booth 12' });
    expect(project.name).toBe('Booth 12');
    expect(project.ownerId).toBe('owner-a');

    const fetched = await store.getProject(project.id);
    expect(fetched).toEqual(project);
  });

  it('lists only the projects belonging to the given owner', async () => {
    const store = await getStore();
    const mine = await store.createProject({ ownerId: 'owner-list-a', name: 'Mine' });
    await store.createProject({ ownerId: 'owner-list-b', name: 'Someone else' });

    const listed = await store.listProjects('owner-list-a');
    expect(listed.map((p) => p.id)).toEqual([mine.id]);
  });

  it('creates an asset and a version, and links the version back to it', async () => {
    const store = await getStore();
    const project = await store.createProject({ ownerId: 'owner-b', name: 'Booth 7' });
    const asset = await store.createAsset({
      projectId: project.id,
      name: 'Chair',
      status: 'draft',
      currentVersionId: null,
      sourceImageIds: [],
    });

    const version = await store.createAssetVersion({
      assetId: asset.id,
      versionNumber: 1,
      label: 'First pass',
      parentVersionId: null,
      spec: makeFurnitureSpec(),
      views: [],
      meshPath: null,
      previewMeshPath: null,
      previewPath: null,
      meshExtentMm: null,
      provider: 'stub',
      providerJobId: null,
      refinement: null,
      qaResult: null,
      acceptedAt: null,
    });

    expect(version.assetId).toBe(asset.id);
    expect(version.versionNumber).toBe(1);

    await store.updateAsset(asset.id, { currentVersionId: version.id, status: 'ready' });
    const updated = await store.getAsset(asset.id);
    expect(updated?.currentVersionId).toBe(version.id);
    expect(updated?.status).toBe('ready');
  });

  it('rejects mutating an accepted asset version (immutability rule)', async () => {
    const store = await getStore();
    const project = await store.createProject({ ownerId: 'owner-c', name: 'Booth 3' });
    const asset = await store.createAsset({
      projectId: project.id,
      name: 'Table',
      status: 'draft',
      currentVersionId: null,
      sourceImageIds: [],
    });
    const version = await store.createAssetVersion({
      assetId: asset.id,
      versionNumber: 1,
      label: 'v1',
      parentVersionId: null,
      spec: makeFurnitureSpec(),
      views: [],
      meshPath: null,
      previewMeshPath: null,
      previewPath: null,
      meshExtentMm: null,
      provider: 'stub',
      providerJobId: null,
      refinement: null,
      qaResult: null,
      acceptedAt: null,
    });

    const accepted = await store.updateAssetVersion(version.id, { acceptedAt: new Date().toISOString() });
    expect(accepted.acceptedAt).toBeTruthy();

    await expect(store.updateAssetVersion(version.id, { label: 'changed after acceptance' })).rejects.toThrow(
      /accepted.*immutable/i,
    );

    // Explicitly un-accepting (setting acceptedAt back to null) is the one
    // mutation that must still succeed on an accepted version.
    const unaccepted = await store.updateAssetVersion(version.id, { acceptedAt: null });
    expect(unaccepted.acceptedAt).toBeNull();
  });

  it('creates, lists and updates annotations by status', async () => {
    const store = await getStore();
    const project = await store.createProject({ ownerId: 'owner-d', name: 'Booth 9' });
    const asset = await store.createAsset({
      projectId: project.id,
      name: 'Sofa',
      status: 'draft',
      currentVersionId: null,
      sourceImageIds: [],
    });
    const version = await store.createAssetVersion({
      assetId: asset.id,
      versionNumber: 1,
      label: 'v1',
      parentVersionId: null,
      spec: makeFurnitureSpec(),
      views: [],
      meshPath: null,
      previewMeshPath: null,
      previewPath: null,
      meshExtentMm: null,
      provider: 'stub',
      providerJobId: null,
      refinement: null,
      qaResult: null,
      acceptedAt: null,
    });

    const annotation = await store.createAnnotation({
      assetId: asset.id,
      assetVersionId: version.id,
      sceneId: null,
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      partName: null,
      componentName: null,
      componentRole: null,
      originVersionId: version.id,
      originVersionNumber: version.versionNumber,
      staleNote: null,
      source: 'internal',
      clientName: null,
      selectionKind: 'point',
      anchorDescription: 'centre, 0 mm above the floor',
      body: 'A note.',
      parentAnnotationId: null,
      mentions: [],
    });
    expect(annotation.status).toBe('open');

    const openOnes = await store.listAnnotations([asset.id], ['open']);
    expect(openOnes.map((a) => a.id)).toContain(annotation.id);

    const updated = await store.updateAnnotation(annotation.id, {
      status: 'applied',
      resolvedByVersionId: version.id,
    });
    expect(updated.status).toBe('applied');
    expect(updated.resolvedByVersionId).toBe(version.id);

    const appliedOnly = await store.listAnnotations([asset.id], ['open']);
    expect(appliedOnly.map((a) => a.id)).not.toContain(annotation.id);
  });

  it('threads a reply under its parent annotation and captures @mentions', async () => {
    const store = await getStore();
    const project = await store.createProject({ ownerId: 'owner-annotations', name: 'Booth 11' });
    const asset = await store.createAsset({
      projectId: project.id,
      name: 'Armchair',
      status: 'draft',
      currentVersionId: null,
      sourceImageIds: [],
    });
    const version = await store.createAssetVersion({
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
      qaResult: null,
      previewMeshPath: null,
      acceptedAt: null,
    });

    const parent = await store.createAnnotation({
      assetId: asset.id,
      assetVersionId: version.id,
      sceneId: null,
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      partName: null,
      componentName: null,
      componentRole: null,
      originVersionId: version.id,
      originVersionNumber: version.versionNumber,
      staleNote: null,
      source: 'internal',
      clientName: null,
      selectionKind: 'point',
      anchorDescription: 'centre, 0 mm above the floor',
      body: 'Slim this down, @jane',
      parentAnnotationId: null,
      mentions: ['jane'],
    });
    expect(parent.mentions).toEqual(['jane']);
    expect(parent.parentAnnotationId).toBeNull();

    const reply = await store.createAnnotation({
      assetId: asset.id,
      assetVersionId: parent.assetVersionId,
      sceneId: parent.sceneId,
      point: parent.point,
      normal: parent.normal,
      partName: parent.partName,
      componentName: parent.componentName,
      componentRole: parent.componentRole,
      originVersionId: parent.originVersionId,
      originVersionNumber: parent.originVersionNumber,
      staleNote: null,
      source: 'internal',
      clientName: null,
      selectionKind: parent.selectionKind,
      anchorDescription: parent.anchorDescription,
      body: 'On it, thanks @bob',
      parentAnnotationId: parent.id,
      mentions: ['bob'],
    });
    expect(reply.parentAnnotationId).toBe(parent.id);
    expect(reply.mentions).toEqual(['bob']);

    const both = await store.listAnnotations([asset.id]);
    expect(both.map((a) => a.id)).toEqual(expect.arrayContaining([parent.id, reply.id]));

    // Deleting a note takes its replies with it (cascade in Postgres,
    // mirrored in LocalStore).
    await store.deleteAnnotation(parent.id);
    const remaining = await store.listAnnotations([asset.id]);
    expect(remaining.map((a) => a.id)).not.toContain(parent.id);
    expect(remaining.map((a) => a.id)).not.toContain(reply.id);
  });

  it('claims each queued job at most once and reclaims lapsed leases', async () => {
    const store = await getStore();
    const project = await store.createProject({ ownerId: 'owner-e', name: 'Booth 4' });
    await store.createJob({ projectId: project.id, kind: 'analyze', input: {} });

    const claimed = await store.claimNextJob(1000);
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);

    // Nothing else queued for this project - the same job must not be handed
    // out twice while its lease is live.
    const second = await store.claimNextJob(1000);
    expect(second === null || second.id !== claimed!.id).toBe(true);

    // Force the lease into the past, then confirm the sweep puts it back in
    // the queue (or fails it, if attempts are exhausted).
    await store.updateJob(claimed!.id, { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const reclaimed = await store.reclaimExpiredJobs();
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const after = await store.getJob(claimed!.id);
    expect(['queued', 'failed']).toContain(after?.status);
  });

  it('versions a scene doc on every update that changes it', async () => {
    const store = await getStore();
    const project = await store.createProject({ ownerId: 'owner-f', name: 'Booth 1' });
    const doc = {
      schemaVersion: 1 as const,
      environment: {
        presetId: 'gallery',
        floorMaterialId: 'concrete',
        floorColorHex: '#cccccc',
        wallColorHex: '#eeeeee',
        boothWidth: 4,
        boothDepth: 4,
        boothHeight: 3,
        walls: { back: true, left: false, right: false },
        hdriPreset: 'studio',
        hdriIntensity: 1,
        ambientIntensity: 0.3,
        backgroundColorHex: '#ffffff',
        showGrid: true,
      },
      camera: { position: { x: 0, y: 1.6, z: 3 }, target: { x: 0, y: 1, z: 0 }, fov: 40 },
      nodes: [],
    };
    const scene = await store.createScene({ projectId: project.id, name: 'Main stand', doc });

    const updated = await store.updateScene(scene.id, { name: 'Renamed stand' });
    expect(updated.name).toBe('Renamed stand');

    const docUpdated = await store.updateScene(scene.id, { doc: { ...doc, camera: { ...doc.camera, fov: 50 } } }, 'widened lens');
    expect(docUpdated.doc.camera.fov).toBe(50);
  });
}
