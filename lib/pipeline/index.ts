import { randomUUID } from 'node:crypto';

import {
  analyzeFurniture,
  conceptRender,
  directScene,
  refineSpec,
  synthesizeViews,
  type ImageInput,
} from '@/lib/ai/gemini';
import { getMeshProvider } from '@/lib/ai/mesh';
import type { Store } from '@/lib/db';
import { env } from '@/lib/env';
import { formatAnnotationForPrompt } from '@/lib/scene/anchor';
import type { AssetVersion, Job, RefinementRequest, SourceImage, SynthesizedView } from '@/lib/types';

/**
 * Pipeline stages.
 *
 * Each job kind does one stage and enqueues the next, so the UI can show real
 * progress and a failure can be retried from the stage that broke rather than
 * from the photographs again.
 *
 *   analyze -> synthesize_views -> reconstruct
 *   refine  -> (optionally) synthesize_views -> reconstruct
 */

export interface StageContext {
  store: Store;
  job: Job;
  report: (progress: number, message: string) => Promise<void>;
}

const key = {
  source: (projectId: string, ext: string) => `${projectId}/sources/${randomUUID()}.${ext}`,
  view: (projectId: string, versionId: string, angle: string) =>
    `${projectId}/views/${versionId}/${angle}.png`,
  render: (projectId: string, sceneId: string, kind: string, ext: string) =>
    `${projectId}/renders/${sceneId}/${kind}-${randomUUID()}.${ext}`,
  mesh: (projectId: string, versionId: string) => `${projectId}/meshes/${versionId}.glb`,
};

export const storageKeys = key;

/** Load source images as bytes so they can be handed to the model layer. */
async function loadImages(store: Store, images: SourceImage[]): Promise<ImageInput[]> {
  const loaded: ImageInput[] = [];
  for (const image of images) {
    const blob = await store.getBlob(image.path);
    if (!blob) continue;
    loaded.push({
      bytes: blob.bytes,
      mimeType: image.mimeType,
      filename: image.filename,
      role: image.role,
    });
  }
  return loaded;
}

/** Absolute URL for a stored object, which vendors fetch server-to-server. */
async function absoluteUrl(store: Store, path: string): Promise<string> {
  const url = await store.blobUrl(path);
  return url.startsWith('http') ? url : new URL(url, env.appUrl).toString();
}

async function nextVersionNumber(store: Store, assetId: string): Promise<number> {
  const versions = await store.listAssetVersions(assetId);
  return versions.reduce((max, v) => Math.max(max, v.versionNumber), 0) + 1;
}

/* -------------------------------------------------------------------------- */
/* Stage 1: analyze                                                           */
/* -------------------------------------------------------------------------- */

async function runAnalyze(ctx: StageContext): Promise<Record<string, unknown>> {
  const { store, job } = ctx;
  const assetId = job.assetId;
  if (!assetId) throw new Error('analyze: job has no assetId');

  const asset = await store.getAsset(assetId);
  if (!asset) throw new Error(`analyze: asset ${assetId} not found`);
  const project = await store.getProject(asset.projectId);

  await ctx.report(0.1, 'Loading photographs');
  const sourceImages = await store.getSourceImages(asset.sourceImageIds);
  const images = await loadImages(store, sourceImages);
  if (images.length === 0) throw new Error('analyze: no readable source images');

  await store.updateAsset(assetId, { status: 'analyzing' });
  await ctx.report(0.35, 'Reading form, materials and dimensions');
  const { spec, source } = await analyzeFurniture(images, project?.brief ?? null);

  await ctx.report(0.8, 'Recording specification');
  const version = await store.createAssetVersion({
    assetId,
    versionNumber: await nextVersionNumber(store, assetId),
    label: source === 'gemini' ? 'Analyzed from photographs' : 'Offline placeholder spec',
    parentVersionId: null,
    spec,
    views: sourceImages
      .filter((i) => i.role !== 'mood')
      .map<SynthesizedView>((i) => ({ angle: i.role, path: i.path, fromSource: true })),
    meshPath: null,
    meshExtentMm: null,
    provider: getMeshProvider().name,
    providerJobId: null,
    refinement: null,
    acceptedAt: null,
  });

  await store.updateAsset(assetId, { status: 'generating_views', name: asset.name || spec.displayName });
  await store.createJob({
    projectId: asset.projectId,
    assetId,
    kind: 'synthesize_views',
    input: { versionId: version.id },
  });

  return { versionId: version.id, specSource: source };
}

/* -------------------------------------------------------------------------- */
/* Stage 2: synthesize canonical views                                        */
/* -------------------------------------------------------------------------- */

async function runSynthesizeViews(ctx: StageContext): Promise<Record<string, unknown>> {
  const { store, job } = ctx;
  const versionId = job.input.versionId as string;
  const version = await store.getAssetVersion(versionId);
  if (!version) throw new Error(`synthesize_views: version ${versionId} not found`);
  const asset = await store.getAsset(version.assetId);
  if (!asset) throw new Error('synthesize_views: asset not found');

  await ctx.report(0.15, 'Loading reference photographs');
  const sourceImages = await store.getSourceImages(asset.sourceImageIds);
  const images = await loadImages(store, sourceImages);

  await ctx.report(0.3, 'Rendering canonical views');
  const generated = await synthesizeViews(images, version.spec);

  // Source photos are always kept as views. Synthesized angles are added on
  // top, so a missing image model degrades to "reconstruct from the originals"
  // rather than failing.
  const views: SynthesizedView[] = [...version.views.filter((v) => v.fromSource)];
  for (const [index, item] of generated.entries()) {
    const path = key.view(asset.projectId, version.id, item.angle);
    await store.putBlob(path, item.image.bytes, item.image.mimeType);
    views.push({ angle: item.angle, path, fromSource: false });
    await ctx.report(0.3 + (0.6 * (index + 1)) / generated.length, `Rendered ${item.angle}`);
  }

  await store.updateAssetVersion(version.id, { views });
  await store.updateAsset(asset.id, { status: 'reconstructing' });
  await store.createJob({
    projectId: asset.projectId,
    assetId: asset.id,
    kind: 'reconstruct',
    input: { versionId: version.id },
  });

  return { viewCount: views.length, synthesized: generated.length };
}

/* -------------------------------------------------------------------------- */
/* Stage 3: reconstruct the mesh                                              */
/* -------------------------------------------------------------------------- */

async function runReconstruct(ctx: StageContext): Promise<Record<string, unknown>> {
  const { store, job } = ctx;
  const versionId = job.input.versionId as string;
  const version = await store.getAssetVersion(versionId);
  if (!version) throw new Error(`reconstruct: version ${versionId} not found`);
  const asset = await store.getAsset(version.assetId);
  if (!asset) throw new Error('reconstruct: asset not found');

  const provider = getMeshProvider();
  await ctx.report(0.05, `Preparing input for ${provider.name}`);

  // Synthesized views first: they are clean-background and consistently framed,
  // which every reconstruction model handles better than a lifestyle photo.
  const ordered = [...version.views].sort((a, b) => Number(a.fromSource) - Number(b.fromSource));
  const imageUrls: string[] = [];
  const images: { bytes: Uint8Array; mimeType: string }[] = [];
  for (const view of ordered) {
    const blob = await store.getBlob(view.path);
    if (!blob) continue;
    images.push({ bytes: blob.bytes, mimeType: blob.contentType });
    imageUrls.push(await absoluteUrl(store, view.path));
  }

  const result = await provider.reconstruct({
    spec: version.spec,
    imageUrls,
    images,
    notes: version.spec.reconstructionNotes,
    onProgress: (progress, message) => ctx.report(progress, message),
  });

  await ctx.report(0.92, 'Storing mesh');
  const meshPath = key.mesh(asset.projectId, version.id);
  await store.putBlob(meshPath, result.glb, 'model/gltf-binary');

  await store.updateAssetVersion(version.id, {
    meshPath,
    meshExtentMm: result.extentMm,
    provider: provider.name,
    providerJobId: result.providerJobId,
  });
  await store.updateAsset(asset.id, { status: 'ready', currentVersionId: version.id });

  return { meshPath, provider: provider.name, bytes: result.glb.byteLength };
}

/* -------------------------------------------------------------------------- */
/* Stage 4: refine an existing version                                        */
/* -------------------------------------------------------------------------- */

async function runRefine(ctx: StageContext): Promise<Record<string, unknown>> {
  const { store, job } = ctx;
  const parentId = job.input.versionId as string;
  const request = job.input.refinement as RefinementRequest;

  const parent = await store.getAssetVersion(parentId);
  if (!parent) throw new Error(`refine: version ${parentId} not found`);
  const asset = await store.getAsset(parent.assetId);
  if (!asset) throw new Error('refine: asset not found');

  // Anchored notes are the substance of a review round; the free-text
  // instruction is often just "apply these".
  const annotations = request.annotationIds?.length
    ? (await store.listAnnotations([asset.id])).filter((a) =>
        request.annotationIds!.includes(a.id),
      )
    : [];

  await ctx.report(
    0.2,
    annotations.length > 0
      ? `Applying ${annotations.length} pinned note${annotations.length === 1 ? '' : 's'}`
      : 'Applying requested changes to the specification',
  );

  let spec = await refineSpec(
    parent.spec,
    request.instruction,
    annotations.map(formatAnnotationForPrompt),
  );

  // Carry the notes into reconstruction too, so a rebuilt mesh reflects them
  // rather than only the specification doing so.
  if (request.rebuildMesh && annotations.length > 0) {
    spec = {
      ...spec,
      reconstructionNotes: [
        spec.reconstructionNotes,
        'Requested corrections:',
        ...annotations.map(formatAnnotationForPrompt),
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  // Explicit overrides win over the model's interpretation.
  if (request.specOverrides) {
    spec = {
      ...spec,
      ...request.specOverrides,
      dimensions: request.specOverrides.dimensions ?? spec.dimensions,
      materials: request.specOverrides.materials ?? spec.materials,
    };
  }

  await ctx.report(0.6, 'Creating new version');
  const version: AssetVersion = await store.createAssetVersion({
    assetId: asset.id,
    versionNumber: await nextVersionNumber(store, asset.id),
    label: describeRefinement(request.instruction, annotations),
    parentVersionId: parent.id,
    spec,
    // Carry the parent's views over; they still depict the same piece.
    views: parent.views,
    meshPath: request.rebuildMesh ? null : parent.meshPath,
    meshExtentMm: request.rebuildMesh ? null : parent.meshExtentMm,
    provider: parent.provider,
    providerJobId: null,
    refinement: request,
    acceptedAt: null,
  });

  // Close the loop: the notes this version answers are no longer open, and
  // point at the version that answered them.
  for (const annotation of annotations) {
    await store.updateAnnotation(annotation.id, {
      status: 'applied',
      resolvedByVersionId: version.id,
    });
  }

  if (request.rebuildMesh) {
    await store.updateAsset(asset.id, { status: 'reconstructing' });
    await store.createJob({
      projectId: asset.projectId,
      assetId: asset.id,
      kind: 'reconstruct',
      input: { versionId: version.id },
    });
  } else {
    // Spec-only change: the geometry is unchanged, so the version is usable now.
    await store.updateAsset(asset.id, { status: 'ready', currentVersionId: version.id });
  }

  return {
    versionId: version.id,
    rebuildMesh: request.rebuildMesh,
    annotationsApplied: annotations.length,
  };
}

/**
 * Name a version after what produced it. A revision driven purely by pinned
 * notes carries no written instruction, so fall back to the notes themselves
 * rather than leaving the version history blank.
 */
function describeRefinement(
  instruction: string,
  annotations: { body: string; componentName: string | null; partName: string | null }[],
): string {
  if (instruction.trim()) return instruction.trim().slice(0, 120);
  if (annotations.length === 0) return 'Refined';
  if (annotations.length === 1) {
    const [note] = annotations;
    const part = note.componentName ?? note.partName;
    return `${part ? `${part}: ` : ''}${note.body}`.slice(0, 120);
  }
  return `${annotations.length} pinned notes`;
}

/* -------------------------------------------------------------------------- */
/* Stage 5: art-direct a scene                                                */
/* -------------------------------------------------------------------------- */

async function runDirectScene(ctx: StageContext): Promise<Record<string, unknown>> {
  const { store, job } = ctx;
  const sceneId = job.input.sceneId as string;
  const scene = await store.getScene(sceneId);
  if (!scene) throw new Error(`direct_scene: scene ${sceneId} not found`);
  const project = await store.getProject(scene.projectId);

  await ctx.report(0.3, 'Reading the pieces on the stand');
  const assets = await store.listAssets(scene.projectId);
  const specs = [];
  for (const asset of assets) {
    if (!asset.currentVersionId) continue;
    const version = await store.getAssetVersion(asset.currentVersionId);
    if (version) specs.push(version.spec);
  }

  await ctx.report(0.6, 'Proposing booth treatment');
  const direction = await directScene(specs, project?.brief ?? null);

  await store.updateScene(
    sceneId,
    {
      direction,
      doc: {
        ...scene.doc,
        environment: {
          ...scene.doc.environment,
          // Apply the proposed palette to the booth surfaces only; the
          // furniture keeps the materials the vision pass derived.
          wallColorHex: direction.paletteHex[0] ?? scene.doc.environment.wallColorHex,
          floorColorHex: direction.paletteHex[1] ?? scene.doc.environment.floorColorHex,
          backgroundColorHex: direction.paletteHex[0] ?? scene.doc.environment.backgroundColorHex,
        },
      },
    },
    'art direction applied',
  );

  return { concept: direction.concept };
}

/* -------------------------------------------------------------------------- */
/* Stage 6: fast concept render over a viewport capture                       */
/* -------------------------------------------------------------------------- */

async function runConceptRender(ctx: StageContext): Promise<Record<string, unknown>> {
  const { store, job } = ctx;
  const sceneId = job.input.sceneId as string;
  const capturePath = job.input.capturePath as string;
  const instruction = (job.input.instruction as string | undefined) ?? null;

  const scene = await store.getScene(sceneId);
  if (!scene) throw new Error(`concept_render: scene ${sceneId} not found`);
  const project = await store.getProject(scene.projectId);

  await ctx.report(0.15, 'Loading viewport capture');
  const capture = await store.getBlob(capturePath);
  if (!capture) throw new Error('concept_render: the viewport capture is missing');

  // Only the pieces actually staged in this scene inform the prompt.
  const stagedVersionIds = [
    ...new Set(scene.doc.nodes.map((n) => n.assetVersionId).filter((id): id is string => !!id)),
  ];
  const pieces = [];
  for (const id of stagedVersionIds) {
    const version = await store.getAssetVersion(id);
    if (version) pieces.push(version.spec);
  }

  await ctx.report(0.4, 'Rendering concept');
  const image = await conceptRender(
    { bytes: capture.bytes, mimeType: capture.contentType },
    { pieces, brief: project?.brief ?? null, instruction },
  );

  await ctx.report(0.85, 'Storing render');
  const extension = image.mimeType.includes('jpeg') ? 'jpg' : 'png';
  const path = key.render(scene.projectId, scene.id, 'concept', extension);
  await store.putBlob(path, image.bytes, image.mimeType);

  const render = await store.createSceneRender({
    sceneId: scene.id,
    projectId: scene.projectId,
    kind: 'concept',
    path,
    width: (job.input.width as number) ?? 0,
    height: (job.input.height as number) ?? 0,
    samples: null,
    prompt: instruction,
  });

  // The capture was only ever an input; do not leave it in storage.
  await store.deleteBlob(capturePath).catch(() => undefined);

  return { renderId: render.id, path };
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

const STAGES: Record<Job['kind'], (ctx: StageContext) => Promise<Record<string, unknown>>> = {
  analyze: runAnalyze,
  synthesize_views: runSynthesizeViews,
  reconstruct: runReconstruct,
  refine: runRefine,
  direct_scene: runDirectScene,
  concept_render: runConceptRender,
};

/** Run one claimed job to completion, recording progress and failure. */
export async function runJob(store: Store, job: Job): Promise<Job> {
  const report = async (progress: number, message: string) => {
    await store.updateJob(job.id, {
      progress: Math.min(0.99, Math.max(0, progress)),
      message,
    });
  };

  try {
    const output = await STAGES[job.kind]({ store, job, report });
    return await store.updateJob(job.id, {
      status: 'succeeded',
      progress: 1,
      message: 'Done',
      output,
      error: null,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Mark the asset failed too, otherwise the UI would spin forever.
    if (job.assetId) {
      await store.updateAsset(job.assetId, { status: 'failed' }).catch(() => undefined);
    }
    return await store.updateJob(job.id, {
      status: 'failed',
      message: 'Failed',
      error: message,
    });
  }
}

/**
 * Drain the queue. Called by the /api/jobs/tick route (which the studio pokes
 * while work is outstanding) and by the standalone worker script.
 */
export async function drainJobs(store: Store, max = 10): Promise<number> {
  let processed = 0;
  while (processed < max) {
    const job = await store.claimNextJob();
    if (!job) break;
    await runJob(store, job);
    processed += 1;
  }
  return processed;
}
