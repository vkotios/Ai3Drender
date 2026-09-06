import {
  analyzeFurniture,
  conceptRender,
  directScene,
  evaluateReconstruction,
  refineSpec,
  synthesizeViews,
  type ImageInput,
} from '@/lib/ai/gemini';
import { getMeshProvider } from '@/lib/ai/mesh';
import { createPreviewMesh } from '@/lib/ai/mesh/simplify';
import { offlineQaResult } from '@/lib/ai/offline';
import { renderMeshViews } from '@/lib/ai/qa/render';
import type { Store } from '@/lib/db';
import { env, hasGemini } from '@/lib/env';
import { anchorWithinBounds, describeAnchor, formatAnnotationForPrompt, resolveComponent } from '@/lib/scene/anchor';

import type { StageContext } from './context';
import { backoffMs, isRetryable } from './errors';
import { runRender } from './render';
import { storageKeys } from './storage-keys';
import type {
  Annotation,
  AssetVersion,
  FurnitureAsset,
  Job,
  QaResult,
  RefinementRequest,
  SourceImage,
  SynthesizedView,
} from '@/lib/types';

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

export type { StageContext } from './context';
export { storageKeys };

const key = storageKeys;

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
  // Offer the account's known materials as candidates so the vision pass
  // matches the piece against real materials instead of re-inventing a
  // near-miss of one that already exists.
  const libraryCandidates = project
    ? await store.listMaterialLibraryEntries(project.ownerId)
    : [];
  const { spec, source } = await analyzeFurniture(images, project?.brief ?? null, libraryCandidates);

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
    previewMeshPath: null,
    meshExtentMm: null,
    previewPath: null,
    provider: getMeshProvider().name,
    providerJobId: null,
    refinement: null,
    qaResult: null,
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

  // A decimated copy for the real-time viewport (and, since it renders the
  // same live scene, the in-browser path tracer) - see issue #47. Best
  // effort: the Blender render worker and glTF/OBJ export never read this
  // field, so a failed or no-op simplification just leaves the viewport on
  // the full-detail mesh rather than failing the whole reconstruction.
  await ctx.report(0.96, 'Simplifying preview mesh');
  let previewMeshPath: string | null = null;
  try {
    const preview = await createPreviewMesh(result.glb, env.viewportMeshSimplifyRatio);
    if (preview) {
      previewMeshPath = key.previewMesh(asset.projectId, version.id);
      await store.putBlob(previewMeshPath, preview.glb, 'model/gltf-binary');
    }
  } catch (cause) {
    console.error(`[reconstruct] preview mesh simplification failed for version ${version.id}`, cause);
  }

  await store.updateAssetVersion(version.id, {
    meshPath,
    previewMeshPath,
    meshExtentMm: result.extentMm,
    provider: provider.name,
    providerJobId: result.providerJobId,
  });

  const qaResult = await runPerceptualQa(ctx, store, asset, version, result.glb);

  await store.updateAsset(asset.id, { status: 'ready', currentVersionId: version.id });

  return {
    meshPath,
    previewMeshPath,
    provider: provider.name,
    bytes: result.glb.byteLength,
    qaScore: qaResult?.score ?? null,
  };
}

/**
 * Perceptual QA: render a couple of stock views of the new mesh and ask
 * Gemini vision whether it actually looks like the source photographs -
 * gltf-transform's round-trip only ever checked that the glTF was structurally
 * valid, never that it resembled anything.
 *
 * Entirely best-effort. A render bug, a flaky Gemini call, or no GEMINI_API_KEY
 * at all must never fail reconstruction: the caller always gets a mesh back,
 * this only ever adds a soft warning on top of one. Any failure here is
 * swallowed (and logged) rather than propagated, and the version's qaResult
 * simply stays whatever it already was (null on a first build).
 */
async function runPerceptualQa(
  ctx: StageContext,
  store: Store,
  asset: FurnitureAsset,
  version: AssetVersion,
  glb: Uint8Array,
): Promise<QaResult | null> {
  try {
    await ctx.report(0.96, 'Checking the mesh against the source photographs');

    // Rendering mesh views and calling Gemini are both real work; skip both
    // entirely rather than pay for a render nothing will use when there is no
    // key to send it to (evaluateReconstruction would return the same offline
    // placeholder either way, but without wastefully rendering first).
    if (!hasGemini) {
      const qaResult = offlineQaResult();
      await store.updateAssetVersion(version.id, { qaResult });
      return qaResult;
    }

    const meshViews = await renderMeshViews(glb);
    const sourceImages = await store.getSourceImages(asset.sourceImageIds);
    const photos = await loadImages(store, sourceImages);
    const qaResult = await evaluateReconstruction(photos, meshViews, version.spec);
    await store.updateAssetVersion(version.id, { qaResult });
    return qaResult;
  } catch (cause) {
    console.error(`[pipeline] reconstruct: perceptual QA failed for version ${version.id}`, cause);
    return null;
  }
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
    previewMeshPath: request.rebuildMesh ? null : parent.previewMeshPath,
    meshExtentMm: request.rebuildMesh ? null : parent.meshExtentMm,
    // A rebuilt mesh needs its own thumbnail; an unchanged one can reuse the parent's.
    previewPath: request.rebuildMesh ? null : parent.previewPath,
    provider: parent.provider,
    providerJobId: null,
    refinement: request,
    // A rebuilt mesh gets its own fresh QA pass once reconstruct runs; an
    // unchanged one is still depicted faithfully by whatever the parent's
    // check already found.
    qaResult: request.rebuildMesh ? null : parent.qaResult,
    acceptedAt: null,
  });

  // Close the loop: the notes this version answers are no longer open, and
  // point at the version that answered them.
  const appliedIds = new Set<string>();
  for (const annotation of annotations) {
    appliedIds.add(annotation.id);
    await store.updateAnnotation(annotation.id, {
      status: 'applied',
      resolvedByVersionId: version.id,
    });
  }

  // Everything else still open on the version being revised would otherwise
  // be left pinned to it forever, invisible against the version the studio
  // now shows. Carry it forward instead.
  const carriedForward = await carryForwardOpenAnnotations(store, asset, parent, version, appliedIds);

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
    annotationsCarriedForward: carriedForward.length,
    annotationsFlagged: carriedForward.filter((a) => a.staleNote).length,
  };
}

/**
 * Re-point every note still `open` on `parent` (and not itself part of this
 * round) at the new `version`, refreshing everything the spec drives.
 *
 * The anchor point and normal are left untouched - they are stored in the
 * asset's local space precisely so the same coordinate keeps meaning the
 * same place on the piece across a rebuilt mesh (see lib/scene/anchor.ts).
 * `partName`, `componentName` and the plain-language location are *not*
 * carried over as-is, though: the part may have been renamed, split or
 * removed by this very refinement, so each is re-resolved against the new
 * spec rather than copied from the old note.
 */
async function carryForwardOpenAnnotations(
  store: Store,
  asset: FurnitureAsset,
  parent: AssetVersion,
  version: AssetVersion,
  excludeIds: Set<string>,
): Promise<Annotation[]> {
  const stillOpen = (await store.listAnnotations([asset.id], ['open'])).filter(
    // A reply piggybacks on its parent's anchor rather than carrying an
    // independent one of its own (see Annotation.parentAnnotationId), so it
    // has no anchor to re-resolve here - only the top-level note it replies
    // to gets carried forward.
    (a) => a.assetVersionId === parent.id && !excludeIds.has(a.id) && !a.parentAnnotationId,
  );

  const carried: Annotation[] = [];
  for (const annotation of stillOpen) {
    const { componentName, componentRole } = resolveComponent(annotation.partName, version.spec);
    const anchorDescription = describeAnchor(annotation.point, version.spec.dimensions);

    // Flag, don't hide: if the anchor can no longer be squared with the new
    // spec, a reviewer should see that rather than act on a pin whose
    // context quietly went stale underneath it.
    let staleNote: string | null = null;
    if (!anchorWithinBounds(annotation.point, version.spec.dimensions)) {
      staleNote =
        `Carried forward from v${annotation.originVersionNumber}: this anchor now falls outside ` +
        `v${version.versionNumber}'s bounding box, so the part it was pinned to may have been ` +
        'resized or removed. Re-check it against the current mesh before acting on it.';
    } else if (annotation.componentName && !componentName) {
      staleNote =
        `Carried forward from v${annotation.originVersionNumber}: "${annotation.componentName}" no ` +
        `longer resolves to a component in v${version.versionNumber} - it may have been renamed, ` +
        'merged or removed. Re-check it against the current mesh before acting on it.';
    }

    const updated = await store.updateAnnotation(annotation.id, {
      assetVersionId: version.id,
      componentName,
      componentRole,
      anchorDescription,
      staleNote,
    });
    carried.push(updated);
  }

  return carried;
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
  render: runRender,
};

/**
 * How long a claim is good for, and how often a working stage renews it.
 * Renewing on every progress report means a stage that is genuinely alive
 * keeps its claim, while one that has wedged loses it and gets reclaimed.
 */
const LEASE_MS = 5 * 60_000;

/** Run one claimed job to completion, recording progress and failure. */
export async function runJob(store: Store, job: Job): Promise<Job> {
  const report = async (progress: number, message: string) => {
    await store.updateJob(job.id, {
      progress: Math.min(0.99, Math.max(0, progress)),
      message,
    });
    // A stage reporting progress is proof of life; push the deadline out.
    await store.extendLease(job.id, LEASE_MS).catch(() => undefined);
  };

  try {
    const output = await STAGES[job.kind]({ store, job, report });
    return await store.updateJob(job.id, {
      status: 'succeeded',
      progress: 1,
      message: 'Done',
      output,
      error: null,
      leaseExpiresAt: null,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const canRetry = isRetryable(cause) && job.attempts < job.maxAttempts;

    if (canRetry) {
      const delay = backoffMs(job.attempts);
      // The asset stays in its working state: from the user's point of view
      // this piece is still being built, just more slowly.
      return await store.updateJob(job.id, {
        status: 'queued',
        // Reset progress: the next attempt starts from the top of the stage,
        // so leaving the old bar part-filled would misreport where it is.
        progress: 0,
        message: `Retrying in ${Math.round(delay / 1000)}s (attempt ${job.attempts + 1} of ${job.maxAttempts})`,
        error: message,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + delay).toISOString(),
      });
    }

    // Out of attempts, or a failure that would fail identically next time.
    // Mark the asset failed too, otherwise the UI would spin forever.
    if (job.assetId) {
      await store.updateAsset(job.assetId, { status: 'failed' }).catch(() => undefined);
    }
    return await store.updateJob(job.id, {
      status: 'failed',
      message: job.attempts >= job.maxAttempts ? `Failed after ${job.attempts} attempts` : 'Failed',
      error: message,
      leaseExpiresAt: null,
    });
  }
}

/**
 * Drain the queue. Called by the /api/jobs/tick route (which the studio pokes
 * while work is outstanding) and by the standalone worker script.
 */
export async function drainJobs(store: Store, max = 10): Promise<number> {
  // Sweep up anything a dead worker left claimed before taking new work.
  await store.reclaimExpiredJobs().catch(() => 0);

  let processed = 0;
  while (processed < max) {
    const job = await store.claimNextJob();
    if (!job) break;
    await runJob(store, job);
    processed += 1;
  }
  return processed;
}
