/**
 * Evaluation entry point for the P3-SAM part-segmentation adapter (issue #57
 * comparison, see lib/ai/segmentation/). NOT wired into any production job -
 * this is the manual-inspection harness the maintainer runs by hand to
 * compare P3-SAM's raw output against the sibling Point-SAM branch's.
 *
 * Run against a local mesh file:
 *   npx tsx scripts/eval-p3sam-segmentation.ts --file path/to/mesh.glb
 *
 * Run against an existing asset version's stored mesh:
 *   npx tsx scripts/eval-p3sam-segmentation.ts --asset-version <uuid>
 *
 * Options:
 *   --out <dir>            output directory (default: eval-output/p3sam-<timestamp>)
 *   --no-postprocess       disable P3-SAM's small-part merge pass
 *   --threshold <0-1>      postprocess merge threshold (default 0.95)
 *   --seed <int>           random seed (default 42)
 *
 * The public HuggingFace Space this hits runs on HuggingFace's shared
 * "ZeroGPU" pool, whose anonymous quota is small - set HUGGINGFACE_TOKEN in
 * the environment for a higher quota. A quota error here is expected and
 * does not mean the adapter is broken; rerun once quota resets, or with a
 * token.
 *
 * Writes, on success:
 *   summary.json       segment count, per-segment face counts, unassigned count
 *   segmented.glb       the mesh P3-SAM returned, colour-coded per part
 *   face-ids.json       the full per-face segment-id array, for exact re-derivation
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getWorkerStore } from '@/lib/db';
import { P3SamProvider } from '@/lib/ai/segmentation/p3sam';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return null;
  return process.argv[index + 1];
}

async function loadGlb(): Promise<{ glb: Uint8Array; label: string }> {
  const filePath = argValue('--file');
  if (filePath) {
    const glb = await readFile(path.resolve(filePath));
    return { glb: new Uint8Array(glb), label: filePath };
  }

  const assetVersionId = argValue('--asset-version');
  if (assetVersionId) {
    const store = getWorkerStore();
    const version = await store.getAssetVersion(assetVersionId);
    if (!version) throw new Error(`no asset version found for id ${assetVersionId}`);
    if (!version.meshPath) throw new Error(`asset version ${assetVersionId} has no meshPath`);
    const blob = await store.getBlob(version.meshPath);
    if (!blob) throw new Error(`no blob stored at ${version.meshPath}`);
    return { glb: blob.bytes, label: `asset version ${assetVersionId} (${version.meshPath})` };
  }

  throw new Error('pass either --file <path.glb> or --asset-version <uuid>');
}

async function main() {
  const { glb, label } = await loadGlb();
  console.log(`[eval] input: ${label} (${glb.byteLength} bytes)`);

  const provider = new P3SamProvider();
  console.log(`[eval] provider: ${provider.name} (configured: ${provider.configured})`);

  const postprocess = !process.argv.includes('--no-postprocess');
  const thresholdArg = argValue('--threshold');
  const seedArg = argValue('--seed');

  console.log(
    `[eval] options: postprocess=${postprocess}` +
      (thresholdArg ? ` threshold=${thresholdArg}` : '') +
      (seedArg ? ` seed=${seedArg}` : ''),
  );

  const outDir = argValue('--out') ?? path.join('eval-output', `p3sam-${Date.now()}`);
  await mkdir(outDir, { recursive: true });

  const start = Date.now();
  const result = await provider.segmentParts({
    meshGlb: glb,
    postprocess,
    postprocessThreshold: thresholdArg ? Number(thresholdArg) : undefined,
    seed: seedArg ? Number(seedArg) : undefined,
  });
  const elapsedS = ((Date.now() - start) / 1000).toFixed(1);

  // Every face is either in exactly one segment or unassigned - see this
  // once locally rather than relying on the (P3-SAM-only) `totalFaceCount`
  // field the shared port dropped once Point-SAM, which never reports one,
  // started implementing the same interface.
  const totalFaceCount =
    result.segments.reduce((sum, s) => sum + s.faceIndices.length, 0) + result.unassignedFaceIndices.length;

  console.log(
    `[eval] done in ${elapsedS}s: ${result.segments.length} parts, ` +
      `${result.unassignedFaceIndices.length}/${totalFaceCount} faces unassigned ` +
      `(job ${result.providerJobId})`,
  );

  if (!result.segmentedGlb) {
    throw new Error('P3-SAM always returns a segmentedGlb; got none - the provider or API contract changed');
  }
  await writeFile(path.join(outDir, 'segmented.glb'), result.segmentedGlb);

  const faceIds = new Array<string | number>(totalFaceCount).fill(-1);
  for (const segment of result.segments) {
    for (const faceIndex of segment.faceIndices) faceIds[faceIndex] = segment.id;
  }
  await writeFile(path.join(outDir, 'face-ids.json'), JSON.stringify(faceIds));

  const summary = {
    input: label,
    provider: provider.name,
    providerJobId: result.providerJobId,
    elapsedSeconds: Number(elapsedS),
    totalFaceCount,
    unassignedFaceCount: result.unassignedFaceIndices.length,
    segments: result.segments.map((s) => ({ id: s.id, faceCount: s.faceIndices.length })),
  };
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`[eval] wrote ${outDir}/{summary.json,segmented.glb,face-ids.json}`);
}

main().catch((cause) => {
  console.error('\n[eval] FAILED:', cause instanceof Error ? (cause.stack ?? cause.message) : cause);
  process.exit(1);
});
