import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { env } from '@/lib/env';
import { buildSceneDocument, writeAndValidateGlb, type AssetMeshSource } from '@/lib/render/build-scene';
import type { RenderPass } from '@/lib/types';

import type { StageContext } from './context';
import { StageError } from './errors';
import { storageKeys } from './storage-keys';

const execFileAsync = promisify(execFile);

/**
 * Offline print-resolution render, via a headless Blender/Cycles pass over a
 * glTF assembled server-side from the SceneDoc (see `lib/render/build-scene.ts`
 * for why there is no live three.js scene to export here instead).
 *
 * Unlike every other stage, this one shells out to a binary this process does
 * not control. `isRetryable` (errors.ts) does not know about any of Blender's
 * failure modes, so every failure here is raised as non-retryable: a missing
 * mesh, a missing Blender binary or a scene Blender chokes on will fail
 * identically on a second attempt, and this stage does not run in an
 * environment predictable enough to assume otherwise.
 */

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_SAMPLES = 128;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const MAX_DIMENSION = 8192;

interface RenderJobInput {
  sceneId: string;
  width?: number;
  height?: number;
  samples?: number;
  denoise?: boolean;
  passes?: RenderPass[];
  format?: 'png' | 'exr';
}

/** What the Python script is expected to print as its final stdout line on success. */
interface BlenderRenderResult {
  beauty: string;
  passes?: Partial<Record<RenderPass, string>>;
  denoised: boolean;
  samples: number;
}

function parseResult(stdout: string): BlenderRenderResult | null {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('RENDER_RESULT ')) continue;
    try {
      return JSON.parse(trimmed.slice('RENDER_RESULT '.length)) as BlenderRenderResult;
    } catch {
      return null;
    }
  }
  return null;
}

function contentTypeFor(ext: string): string {
  return ext === 'exr' ? 'image/x-exr' : 'image/png';
}

export async function runRender(ctx: StageContext): Promise<Record<string, unknown>> {
  const { store, job } = ctx;
  const input = job.input as unknown as RenderJobInput;
  if (!input?.sceneId) throw new StageError('render: job has no sceneId', false);

  const scene = await store.getScene(input.sceneId);
  if (!scene) throw new StageError(`render: scene ${input.sceneId} not found`, false);

  const width = Math.min(MAX_DIMENSION, Math.max(16, Math.round(input.width ?? DEFAULT_WIDTH)));
  const height = Math.min(MAX_DIMENSION, Math.max(16, Math.round(input.height ?? DEFAULT_HEIGHT)));
  const samples = Math.min(4096, Math.max(1, Math.round(input.samples ?? DEFAULT_SAMPLES)));
  const denoise = input.denoise ?? true;
  const passes = input.passes ?? [];
  const format = input.format ?? 'png';

  await ctx.report(0.05, 'Assembling scene graph');

  // Cache resolved meshes: several nodes may point at the same AssetVersion.
  const meshCache = new Map<string, AssetMeshSource | null>();
  async function loadAssetMesh(assetVersionId: string): Promise<AssetMeshSource | null> {
    if (meshCache.has(assetVersionId)) return meshCache.get(assetVersionId)!;
    const version = await store.getAssetVersion(assetVersionId);
    let result: AssetMeshSource | null = null;
    if (version?.meshPath) {
      const blob = await store.getBlob(version.meshPath);
      if (blob) {
        const dims = version.spec.dimensions;
        result = {
          glb: blob.bytes,
          meshExtentMm: version.meshExtentMm,
          targetLongestM: Math.max(dims.widthMm, dims.depthMm, dims.heightMm, 1) / 1000,
        };
      }
    }
    meshCache.set(assetVersionId, result);
    return result;
  }

  const { document, warnings, renderableNodeCount } = await buildSceneDocument(scene.doc, loadAssetMesh);
  if (renderableNodeCount === 0) {
    throw new StageError(
      'render: nothing to render - the scene has no staged pieces or props with a finished mesh',
      false,
    );
  }

  await ctx.report(0.15, 'Exporting glTF');
  const glb = await writeAndValidateGlb(document);

  const tempDir = await mkdtemp(path.join(tmpdir(), 'ai3drender-render-'));
  const outDir = path.join(tempDir, 'out');
  await mkdir(outDir, { recursive: true });

  try {
    const scenePath = path.join(tempDir, 'scene.glb');
    await writeFile(scenePath, glb);

    const paramsPath = path.join(tempDir, 'params.json');
    await writeFile(
      paramsPath,
      JSON.stringify({
        width,
        height,
        samples,
        denoise,
        passes,
        format,
        device: env.blenderDevice,
        // Real-render (world/film) settings that do not travel through the glTF -
        // see the module doc in lib/render/build-scene.ts for why.
        environment: {
          backgroundColorHex: scene.doc.environment.backgroundColorHex,
          ambientIntensity: scene.doc.environment.ambientIntensity,
          hdriIntensity: scene.doc.environment.hdriIntensity,
        },
      }),
      'utf8',
    );

    const scriptPath = path.join(process.cwd(), 'scripts', 'blender', 'render.py');

    await ctx.report(0.25, `Rendering (${samples} samples${denoise ? ', denoised' : ''})`);

    let stdout = '';
    try {
      const result = await execFileAsync(
        env.blenderBin,
        [
          '-b',
          '-noaudio',
          '--python-exit-code',
          '1',
          '--python',
          scriptPath,
          '--',
          '--scene',
          scenePath,
          '--params',
          paramsPath,
          '--out',
          outDir,
        ],
        { timeout: env.blenderTimeoutMs, maxBuffer: MAX_BUFFER },
      );
      stdout = result.stdout;
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
      if (err.code === 'ENOENT') {
        throw new StageError(
          `render: Blender was not found (looked for "${env.blenderBin}"). Set BLENDER_BIN, or install ` +
            'Blender on this worker - see scripts/blender/render.py for what it is invoked with.',
          false,
          { cause },
        );
      }
      const tail = (err.stderr ?? '').trim().split('\n').slice(-25).join('\n');
      const reason = err.killed
        ? `timed out after ${env.blenderTimeoutMs}ms`
        : `exited with an error${tail ? `:\n${tail}` : ''}`;
      throw new StageError(`render: Blender ${reason}`, false, { cause });
    }

    const parsed = parseResult(stdout);
    if (!parsed) {
      throw new StageError(
        'render: Blender exited cleanly but did not report a result (see scripts/blender/render.py)',
        false,
      );
    }

    await ctx.report(0.85, 'Storing render');
    const ext = format === 'exr' ? 'exr' : 'png';
    const primaryPath = storageKeys.render(scene.projectId, scene.id, 'render', ext);
    const beautyBytes = await readFile(path.join(outDir, parsed.beauty));
    await store.putBlob(primaryPath, new Uint8Array(beautyBytes), contentTypeFor(ext));

    const passPaths: Partial<Record<RenderPass, string>> = {};
    for (const [pass, filename] of Object.entries(parsed.passes ?? {})) {
      const bytes = await readFile(path.join(outDir, filename)).catch(() => null);
      if (!bytes) continue;
      const passPath = primaryPath.replace(/(\.\w+)$/, `-${pass}$1`);
      await store.putBlob(passPath, new Uint8Array(bytes), contentTypeFor(ext));
      passPaths[pass as RenderPass] = passPath;
    }

    const render = await store.createSceneRender({
      sceneId: scene.id,
      projectId: scene.projectId,
      kind: 'render',
      path: primaryPath,
      width,
      height,
      samples: parsed.samples ?? samples,
      prompt: null,
    });

    return {
      renderId: render.id,
      path: primaryPath,
      passPaths,
      denoised: parsed.denoised,
      warnings,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
