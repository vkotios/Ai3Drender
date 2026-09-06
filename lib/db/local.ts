import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import lockfile from 'proper-lockfile';

import type {
  Annotation,
  AnnotationStatus,
  AssetVersion,
  FurnitureAsset,
  Job,
  JobStatus,
  Project,
  Scene,
  SceneDoc,
  SceneRender,
  SourceImage,
  Uuid,
} from '@/lib/types';
import type {
  Blob,
  NewAnnotation,
  NewAsset,
  NewAssetVersion,
  NewJob,
  NewSceneRender,
  NewProject,
  NewScene,
  NewSourceImage,
  Store,
} from './store';

interface Db {
  projects: Project[];
  sourceImages: SourceImage[];
  assets: FurnitureAsset[];
  assetVersions: AssetVersion[];
  scenes: Scene[];
  sceneVersions: { id: string; sceneId: string; versionNumber: number; doc: SceneDoc; note: string; createdAt: string }[];
  jobs: Job[];
  annotations: Annotation[];
  sceneRenders: SceneRender[];
}

const EMPTY: Db = {
  projects: [],
  sourceImages: [],
  assets: [],
  assetVersions: [],
  scenes: [],
  sceneVersions: [],
  jobs: [],
  annotations: [],
  sceneRenders: [],
};

const DEFAULT_ROOT = path.join(process.cwd(), 'storage-local');

const now = () => new Date().toISOString();

/**
 * How long a claim is good for. Long enough that a stage polling a slow mesh
 * vendor is not reclaimed mid-flight, since it extends the lease as it
 * reports progress anyway.
 */
const DEFAULT_LEASE_MS = 5 * 60_000;

/**
 * How long before a lock held by a vanished process is treated as abandoned.
 * Long enough to cover any single write, short enough that a killed worker
 * does not wedge the dev server for long.
 */
const LOCK_STALE_MS = 10_000;

/**
 * Development store. Everything lives in one JSON file plus a blob directory.
 *
 * Concurrency is handled in two layers, because both kinds actually happen:
 * the README suggests running `npm run worker` alongside the dev server, which
 * is two processes on one file.
 *
 * 1. An in-process promise chain keeps this process's own writes ordered and
 *    avoids fighting itself for the file lock.
 * 2. An advisory lock file around each read-modify-write keeps SEPARATE
 *    processes from clobbering each other. Without it the rename is atomic but
 *    the read-modify-write around it is not, so two drainers could read the
 *    same state, and a job could be claimed twice.
 *
 * Reads are deliberately not locked. A write only ever becomes visible via
 * rename, so a reader sees either the whole previous file or the whole next
 * one - never a torn mixture.
 *
 * This is still the development store: it is fine for a dev server plus a
 * worker, and not intended for production - use `SupabaseStore` there.
 */
export class LocalStore implements Store {
  readonly kind = 'local' as const;

  private readonly root: string;
  private readonly dbFile: string;
  private readonly blobDir: string;

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param root Where the database file and blob directory live. Defaults to
   * `<cwd>/storage-local`. Overridable so tests (and any other embedder) can
   * point at an isolated directory instead of the real dev store.
   */
  constructor(root: string = DEFAULT_ROOT) {
    this.root = root;
    this.dbFile = path.join(root, 'db.json');
    this.blobDir = path.join(root, 'blobs');
  }

  private async read(): Promise<Db> {
    try {
      const raw = await readFile(this.dbFile, 'utf8');
      return { ...EMPTY, ...(JSON.parse(raw) as Partial<Db>) };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /**
   * Take the cross-process advisory lock for the duration of `fn`.
   *
   * `realpath: false` because the database file may not exist yet on a first
   * run. `stale` bounds how long a lock held by a process that died can block
   * everyone else; proper-lockfile treats an older lock as abandoned and
   * takes it over.
   */
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const release = await lockfile.lock(this.dbFile, {
      realpath: false,
      stale: LOCK_STALE_MS,
      // Roughly five seconds of patience, which comfortably covers another
      // process writing a database of this size.
      retries: { retries: 40, factor: 1.4, minTimeout: 20, maxTimeout: 400 },
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /** Serialised read-modify-write. All mutations go through here. */
  private mutate<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(() =>
      this.withFileLock(async () => {
        // Read inside the lock: anything read before taking it may already be
        // stale, which is exactly the lost-update this guards against.
        const db = await this.read();
        const result = await fn(db);
        // The pid keeps two processes from colliding on the same temp path.
        const tmp = `${this.dbFile}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
        await rename(tmp, this.dbFile);
        return result;
      }),
    );
    // Keep the chain alive even when a caller's callback throws.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /* Projects --------------------------------------------------------------- */

  async listProjects(ownerId: string): Promise<Project[]> {
    const db = await this.read();
    return db.projects
      .filter((p) => p.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createProject(input: NewProject): Promise<Project> {
    return this.mutate((db) => {
      const project: Project = {
        id: randomUUID(),
        ownerId: input.ownerId,
        name: input.name,
        client: input.client ?? null,
        brief: input.brief ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      db.projects.push(project);
      return project;
    });
  }

  async getProject(id: Uuid): Promise<Project | null> {
    const db = await this.read();
    return db.projects.find((p) => p.id === id) ?? null;
  }

  updateProject(id: Uuid, patch: Partial<Project>): Promise<Project> {
    return this.mutate((db) => {
      const project = db.projects.find((p) => p.id === id);
      if (!project) throw new Error(`project ${id} not found`);
      Object.assign(project, patch, { updatedAt: now() });
      return project;
    });
  }

  deleteProject(id: Uuid): Promise<void> {
    return this.mutate((db) => {
      const assetIds = db.assets.filter((a) => a.projectId === id).map((a) => a.id);
      const sceneIds = db.scenes.filter((s) => s.projectId === id).map((s) => s.id);
      db.projects = db.projects.filter((p) => p.id !== id);
      db.sourceImages = db.sourceImages.filter((i) => i.projectId !== id);
      db.assets = db.assets.filter((a) => a.projectId !== id);
      db.assetVersions = db.assetVersions.filter((v) => !assetIds.includes(v.assetId));
      db.scenes = db.scenes.filter((s) => s.projectId !== id);
      db.sceneVersions = db.sceneVersions.filter((v) => !sceneIds.includes(v.sceneId));
      db.jobs = db.jobs.filter((j) => j.projectId !== id);
      db.annotations = db.annotations.filter((a) => !assetIds.includes(a.assetId));
      db.sceneRenders = db.sceneRenders.filter((r) => r.projectId !== id);
    });
  }

  /* Source images ---------------------------------------------------------- */

  addSourceImage(input: NewSourceImage): Promise<SourceImage> {
    return this.mutate((db) => {
      const image: SourceImage = { ...input, id: randomUUID(), createdAt: now() };
      db.sourceImages.push(image);
      return image;
    });
  }

  async listSourceImages(projectId: Uuid): Promise<SourceImage[]> {
    const db = await this.read();
    return db.sourceImages
      .filter((i) => i.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSourceImages(ids: Uuid[]): Promise<SourceImage[]> {
    const db = await this.read();
    // Preserve the caller's ordering - the first image is treated as primary.
    return ids
      .map((id) => db.sourceImages.find((i) => i.id === id))
      .filter((i): i is SourceImage => Boolean(i));
  }

  deleteSourceImage(id: Uuid): Promise<void> {
    return this.mutate((db) => {
      db.sourceImages = db.sourceImages.filter((i) => i.id !== id);
    });
  }

  /* Assets ----------------------------------------------------------------- */

  createAsset(input: NewAsset): Promise<FurnitureAsset> {
    return this.mutate((db) => {
      const asset: FurnitureAsset = { ...input, id: randomUUID(), createdAt: now(), updatedAt: now() };
      db.assets.push(asset);
      return asset;
    });
  }

  async getAsset(id: Uuid): Promise<FurnitureAsset | null> {
    const db = await this.read();
    return db.assets.find((a) => a.id === id) ?? null;
  }

  async listAssets(projectId: Uuid): Promise<FurnitureAsset[]> {
    const db = await this.read();
    return db.assets
      .filter((a) => a.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateAsset(id: Uuid, patch: Partial<FurnitureAsset>): Promise<FurnitureAsset> {
    return this.mutate((db) => {
      const asset = db.assets.find((a) => a.id === id);
      if (!asset) throw new Error(`asset ${id} not found`);
      Object.assign(asset, patch, { updatedAt: now() });
      return asset;
    });
  }

  deleteAsset(id: Uuid): Promise<void> {
    return this.mutate((db) => {
      db.assets = db.assets.filter((a) => a.id !== id);
      db.assetVersions = db.assetVersions.filter((v) => v.assetId !== id);
      db.annotations = db.annotations.filter((a) => a.assetId !== id);
    });
  }

  /* Asset versions --------------------------------------------------------- */

  createAssetVersion(input: NewAssetVersion): Promise<AssetVersion> {
    return this.mutate((db) => {
      const version: AssetVersion = { ...input, id: randomUUID(), createdAt: now() };
      db.assetVersions.push(version);
      return version;
    });
  }

  async getAssetVersion(id: Uuid): Promise<AssetVersion | null> {
    const db = await this.read();
    return db.assetVersions.find((v) => v.id === id) ?? null;
  }

  async listAssetVersions(assetId: Uuid): Promise<AssetVersion[]> {
    const db = await this.read();
    return db.assetVersions
      .filter((v) => v.assetId === assetId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  updateAssetVersion(id: Uuid, patch: Partial<AssetVersion>): Promise<AssetVersion> {
    return this.mutate((db) => {
      const version = db.assetVersions.find((v) => v.id === id);
      if (!version) throw new Error(`asset version ${id} not found`);
      // Mirrors the Postgres trigger: accepted versions are frozen.
      if (version.acceptedAt && patch.acceptedAt !== null) {
        throw new Error(`asset version ${id} is accepted and immutable`);
      }
      Object.assign(version, patch);
      return version;
    });
  }

  /* Scenes ----------------------------------------------------------------- */

  createScene(input: NewScene): Promise<Scene> {
    return this.mutate((db) => {
      const scene: Scene = {
        id: randomUUID(),
        projectId: input.projectId,
        name: input.name,
        doc: input.doc,
        direction: input.direction ?? null,
        acceptedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      db.scenes.push(scene);
      db.sceneVersions.push({
        id: randomUUID(),
        sceneId: scene.id,
        versionNumber: 1,
        doc: input.doc,
        note: 'created',
        createdAt: now(),
      });
      return scene;
    });
  }

  async getScene(id: Uuid): Promise<Scene | null> {
    const db = await this.read();
    return db.scenes.find((s) => s.id === id) ?? null;
  }

  async listScenes(projectId: Uuid): Promise<Scene[]> {
    const db = await this.read();
    return db.scenes
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateScene(id: Uuid, patch: Partial<Scene>, note = ''): Promise<Scene> {
    return this.mutate((db) => {
      const scene = db.scenes.find((s) => s.id === id);
      if (!scene) throw new Error(`scene ${id} not found`);
      Object.assign(scene, patch, { updatedAt: now() });
      if (patch.doc) {
        const highest = db.sceneVersions
          .filter((v) => v.sceneId === id)
          .reduce((max, v) => Math.max(max, v.versionNumber), 0);
        db.sceneVersions.push({
          id: randomUUID(),
          sceneId: id,
          versionNumber: highest + 1,
          doc: patch.doc,
          note,
          createdAt: now(),
        });
      }
      return scene;
    });
  }

  deleteScene(id: Uuid): Promise<void> {
    return this.mutate((db) => {
      db.scenes = db.scenes.filter((s) => s.id !== id);
      db.sceneVersions = db.sceneVersions.filter((v) => v.sceneId !== id);
      db.sceneRenders = db.sceneRenders.filter((r) => r.sceneId !== id);
    });
  }

  /* Jobs ------------------------------------------------------------------- */

  createJob(input: NewJob): Promise<Job> {
    return this.mutate((db) => {
      const job: Job = {
        id: randomUUID(),
        projectId: input.projectId,
        assetId: input.assetId ?? null,
        kind: input.kind,
        status: 'queued',
        progress: 0,
        message: 'Queued',
        error: null,
        input: input.input ?? {},
        output: null,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      db.jobs.push(job);
      return job;
    });
  }

  async getJob(id: Uuid): Promise<Job | null> {
    const db = await this.read();
    return db.jobs.find((j) => j.id === id) ?? null;
  }

  async listJobs(projectId: Uuid, statuses?: JobStatus[]): Promise<Job[]> {
    const db = await this.read();
    return db.jobs
      .filter((j) => j.projectId === projectId && (!statuses || statuses.includes(j.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  updateJob(id: Uuid, patch: Partial<Job>): Promise<Job> {
    return this.mutate((db) => {
      const job = db.jobs.find((j) => j.id === id);
      if (!job) throw new Error(`job ${id} not found`);
      Object.assign(job, patch, { updatedAt: now() });
      return job;
    });
  }

  claimNextJob(leaseMs = DEFAULT_LEASE_MS): Promise<Job | null> {
    // The mutate() chain is the lock: no two claims can interleave in-process.
    return this.mutate((db) => {
      const at = Date.now();
      const job = db.jobs
        .filter(
          (j) =>
            j.status === 'queued' &&
            // A job backing off after a failure is not yet claimable.
            (!j.nextAttemptAt || Date.parse(j.nextAttemptAt) <= at),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return null;

      job.status = 'running';
      job.attempts += 1;
      job.message = job.attempts > 1 ? `Retrying (attempt ${job.attempts})` : 'Starting';
      job.leaseExpiresAt = new Date(at + leaseMs).toISOString();
      job.nextAttemptAt = null;
      job.updatedAt = now();
      return job;
    });
  }

  extendLease(id: Uuid, leaseMs: number): Promise<void> {
    return this.mutate((db) => {
      const job = db.jobs.find((j) => j.id === id);
      // Only the holder of a live claim may extend it. A job reclaimed out
      // from under a stalled worker must not be pulled back.
      if (!job || job.status !== 'running') return;
      job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    });
  }

  reclaimExpiredJobs(): Promise<number> {
    return this.mutate((db) => {
      const at = Date.now();
      let reclaimed = 0;

      for (const job of db.jobs) {
        if (job.status !== 'running') continue;
        if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > at) continue;

        reclaimed += 1;
        job.leaseExpiresAt = null;
        job.updatedAt = now();

        if (job.attempts >= job.maxAttempts) {
          job.status = 'failed';
          job.message = 'Failed';
          job.error = `Abandoned by a worker after ${job.attempts} attempt(s)`;
        } else {
          job.status = 'queued';
          job.message = 'Queued after a worker stopped responding';
          // Straight back in the queue: the lease already provided the delay.
          job.nextAttemptAt = null;
        }
      }
      return reclaimed;
    });
  }

  /* Annotations ------------------------------------------------------------ */

  createAnnotation(input: NewAnnotation): Promise<Annotation> {
    return this.mutate((db) => {
      const annotation: Annotation = {
        ...input,
        id: randomUUID(),
        status: 'open',
        resolvedByVersionId: null,
        createdAt: now(),
      };
      db.annotations.push(annotation);
      return annotation;
    });
  }

  async getAnnotation(id: Uuid): Promise<Annotation | null> {
    const db = await this.read();
    return db.annotations.find((a) => a.id === id) ?? null;
  }

  async listAnnotations(assetIds: Uuid[], statuses?: AnnotationStatus[]): Promise<Annotation[]> {
    if (assetIds.length === 0) return [];
    const db = await this.read();
    return db.annotations
      .filter((a) => assetIds.includes(a.assetId) && (!statuses || statuses.includes(a.status)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  updateAnnotation(id: Uuid, patch: Partial<Annotation>): Promise<Annotation> {
    return this.mutate((db) => {
      const annotation = db.annotations.find((a) => a.id === id);
      if (!annotation) throw new Error(`annotation ${id} not found`);
      Object.assign(annotation, patch);
      return annotation;
    });
  }

  deleteAnnotation(id: Uuid): Promise<void> {
    return this.mutate((db) => {
      db.annotations = db.annotations.filter((a) => a.id !== id);
    });
  }

  /* Rendered output -------------------------------------------------------- */

  createSceneRender(input: NewSceneRender): Promise<SceneRender> {
    return this.mutate((db) => {
      const render: SceneRender = { ...input, id: randomUUID(), createdAt: now() };
      db.sceneRenders.push(render);
      return render;
    });
  }

  async listSceneRenders(sceneId: Uuid): Promise<SceneRender[]> {
    const db = await this.read();
    return db.sceneRenders
      .filter((r) => r.sceneId === sceneId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  deleteSceneRender(id: Uuid): Promise<void> {
    return this.mutate((db) => {
      db.sceneRenders = db.sceneRenders.filter((r) => r.id !== id);
    });
  }

  /* Blobs ------------------------------------------------------------------ */

  private blobPath(key: string): string {
    // Keys are app-generated (`<project>/<kind>/<uuid>.<ext>`), but refuse to
    // escape the blob root regardless.
    const resolved = path.resolve(this.blobDir, key);
    if (!resolved.startsWith(this.blobDir + path.sep)) {
      throw new Error(`illegal blob key: ${key}`);
    }
    return resolved;
  }

  async putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const file = this.blobPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await writeFile(`${file}.type`, contentType, 'utf8');
    return key;
  }

  async getBlob(key: string): Promise<Blob | null> {
    try {
      const file = this.blobPath(key);
      const bytes = await readFile(file);
      const contentType = await readFile(`${file}.type`, 'utf8').catch(
        () => 'application/octet-stream',
      );
      return { bytes: new Uint8Array(bytes), contentType };
    } catch {
      return null;
    }
  }

  async deleteBlob(key: string): Promise<void> {
    const file = this.blobPath(key);
    await rm(file, { force: true });
    await rm(`${file}.type`, { force: true });
  }

  async blobUrl(key: string): Promise<string> {
    // Served by app/api/blob/[...key]/route.ts.
    return `/api/blob/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}
