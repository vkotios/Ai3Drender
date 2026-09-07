/**
 * Evaluation harness for the Point-SAM part-segmentation candidate (issue
 * #57 - see lib/ai/segmentation/pointsam.ts and services/pointsam/). This is
 * NOT wired into the production pipeline; it exists so a maintainer with a
 * running services/pointsam instance can point this at a real mesh, inspect
 * the raw segments Point-SAM returns, and compare that output against the
 * sibling P3-SAM branch's own harness on the same mesh.
 *
 * Usage:
 *   POINTSAM_SERVICE_URL=http://localhost:8000 \
 *     npx tsx scripts/eval-pointsam.ts --point 0,0.22,0 [--mesh path/to.glb] [--label 1] [--out result.json]
 *
 * --mesh is optional: omit it and the harness segments a synthetic lounge-
 * chair block model (the same stub massing generator lib/ai/mesh/stub.ts
 * uses), so the contract can be exercised with no real vendor asset on hand.
 * --point is the 3D prompt point, in that mesh's own local coordinate space
 * (metres) - for the synthetic mesh, y is up and the seat sits around
 * y=0.44, so a leg midpoint is roughly (0.3, 0.2, 0.3).
 *
 * This never fabricates a response: with no reachable POINTSAM_SERVICE_URL,
 * `PointSamProvider.segmentParts` throws and this script fails loudly with
 * that error, rather than pretending to have evaluated anything.
 */
import { writeFile } from 'node:fs/promises';

import { buildMassingGlb } from '@/lib/ai/mesh/massing';
import { PointSamProvider } from '@/lib/ai/segmentation/pointsam';
import type { FurnitureSpec } from '@/lib/types';

const SYNTHETIC_SPEC: FurnitureSpec = {
  displayName: 'Eval Lounge Chair',
  category: 'lounge chair',
  summary: 'Synthetic fixture for the Point-SAM evaluation harness.',
  dimensions: { widthMm: 700, depthMm: 720, heightMm: 800 },
  seatHeightMm: 440,
  dimensionConfidence: 'stated',
  components: [
    {
      name: 'Legs',
      role: 'leg',
      materialId: 'frame',
      approxSizeMm: { widthMm: 40, depthMm: 40, heightMm: 440 },
    },
    {
      name: 'Seat',
      role: 'seat',
      materialId: 'frame',
      approxSizeMm: { widthMm: 630, depthMm: 650, heightMm: 100 },
    },
    {
      name: 'Backrest',
      role: 'backrest',
      materialId: 'frame',
      approxSizeMm: { widthMm: 630, depthMm: 100, heightMm: 360 },
    },
  ],
  materials: [
    {
      id: 'frame',
      name: 'Solid timber frame',
      kind: 'wood',
      baseColorHex: '#8B5A2B',
      roughness: 0.55,
      metalness: 0,
      sheen: 0,
      clearcoat: 0.25,
      finish: 'oiled',
      notes: '',
    },
  ],
  palette: ['#8B5A2B'],
  styleTags: ['contemporary'],
  symmetry: 'bilateral',
  reconstructionNotes: '',
};

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.point) {
    console.error(
      'Usage: npx tsx scripts/eval-pointsam.ts --point x,y,z [--mesh path/to.glb] [--label 0|1] [--out result.json]',
    );
    console.error('(requires POINTSAM_SERVICE_URL to point at a running services/pointsam instance)');
    process.exit(1);
  }

  const [x, y, z] = args.point.split(',').map(Number);
  if ([x, y, z].some((n) => !Number.isFinite(n))) {
    throw new Error(`--point must be "x,y,z" (metres), got "${args.point}"`);
  }
  const label = args.label ? (Number(args.label) as 0 | 1) : 1;

  let meshGlb: Uint8Array;
  if (args.mesh) {
    console.log(`[eval-pointsam] reading mesh from ${args.mesh}`);
    meshGlb = new Uint8Array(await (await import('node:fs/promises')).readFile(args.mesh));
  } else {
    console.log('[eval-pointsam] no --mesh given, segmenting the synthetic lounge-chair block model');
    meshGlb = buildMassingGlb(SYNTHETIC_SPEC);
  }

  const provider = new PointSamProvider();
  console.log(`[eval-pointsam] provider configured: ${provider.configured}`);
  if (!provider.configured) {
    console.error('POINTSAM_SERVICE_URL is not set - point it at a running services/pointsam instance first.');
    process.exit(1);
  }

  console.log(`[eval-pointsam] prompt point (${x}, ${y}, ${z}), label ${label}`);
  const start = Date.now();
  const result = await provider.segmentParts({
    meshGlb,
    promptPoint: { x, y, z, label },
    onProgress: (progress, message) => console.log(`[eval-pointsam] ${Math.round(progress * 100)}% ${message}`),
  });
  const elapsedMs = Date.now() - start;

  console.log(`\n[eval-pointsam] done in ${elapsedMs}ms - ${result.segments.length} segment(s):`);
  for (const segment of result.segments) {
    const score = segment.score === null ? 'n/a' : segment.score.toFixed(3);
    console.log(`  - ${segment.id}: ${segment.faceIndices.length} face(s), score ${score}`);
  }

  if (args.out) {
    await writeFile(args.out, JSON.stringify({ ...result, elapsedMs }, null, 2));
    console.log(`\n[eval-pointsam] wrote raw result to ${args.out}`);
  }
}

main().catch((cause) => {
  console.error('\n[eval-pointsam] FAILED:', cause instanceof Error ? (cause.stack ?? cause.message) : cause);
  process.exit(1);
});
