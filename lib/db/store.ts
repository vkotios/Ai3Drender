import type {
  Annotation,
  AnnotationStatus,
  AssetVersion,
  FurnitureAsset,
  Job,
  JobKind,
  JobStatus,
  Project,
  Scene,
  SceneDoc,
  SceneRender,
  SceneVersion,
  SourceImage,
  Uuid,
} from '@/lib/types';

export interface Blob {
  bytes: Uint8Array;
  contentType: string;
}

export interface NewProject {
  ownerId: string;
  name: string;
  client?: string | null;
  brief?: string | null;
}

export type NewSourceImage = Omit<SourceImage, 'id' | 'createdAt'>;
export type NewAsset = Omit<FurnitureAsset, 'id' | 'createdAt' | 'updatedAt'>;
export type NewAssetVersion = Omit<AssetVersion, 'id' | 'createdAt'>;
export interface NewScene {
  projectId: Uuid;
  name: string;
  doc: SceneDoc;
  direction?: Scene['direction'];
}
export type NewAnnotation = Omit<
  Annotation,
  'id' | 'createdAt' | 'status' | 'resolvedByVersionId'
>;
export type NewSceneRender = Omit<SceneRender, 'id' | 'createdAt'>;

/**
 * Thrown by `updateScene` when a `doc` write's `expectedVersion` no longer
 * matches the scene's current version - i.e. someone else saved in between.
 * Carries the scene as it stands now, so the caller can show what changed.
 */
export class SceneConflictError extends Error {
  constructor(public readonly current: Scene) {
    super(
      `scene ${current.id} is at version ${current.version}, which does not match the expected version`,
    );
    this.name = 'SceneConflictError';
  }
}
export interface NewJob {
  projectId: Uuid;
  assetId?: Uuid | null;
  kind: JobKind;
  input?: Record<string, unknown>;
  /** Defaults to 3. Set to 1 for work that must never be repeated. */
  maxAttempts?: number;
}

/**
 * Persistence port. Two implementations exist: `SupabaseStore` for deployed
 * environments and `LocalStore` (JSON + files on disk) so the whole pipeline
 * can be exercised without any accounts.
 *
 * Callers must scope every read by a project they have already authorised;
 * the store itself does not re-check ownership beyond what RLS enforces.
 */
export interface Store {
  readonly kind: 'supabase' | 'local';

  /* Projects */
  listProjects(ownerId: string): Promise<Project[]>;
  createProject(input: NewProject): Promise<Project>;
  getProject(id: Uuid): Promise<Project | null>;
  updateProject(id: Uuid, patch: Partial<Pick<Project, 'name' | 'client' | 'brief'>>): Promise<Project>;
  deleteProject(id: Uuid): Promise<void>;

  /* Source images */
  addSourceImage(input: NewSourceImage): Promise<SourceImage>;
  listSourceImages(projectId: Uuid): Promise<SourceImage[]>;
  getSourceImages(ids: Uuid[]): Promise<SourceImage[]>;
  deleteSourceImage(id: Uuid): Promise<void>;

  /* Assets */
  createAsset(input: NewAsset): Promise<FurnitureAsset>;
  getAsset(id: Uuid): Promise<FurnitureAsset | null>;
  listAssets(projectId: Uuid): Promise<FurnitureAsset[]>;
  updateAsset(
    id: Uuid,
    patch: Partial<Pick<FurnitureAsset, 'name' | 'status' | 'currentVersionId'>>,
  ): Promise<FurnitureAsset>;
  deleteAsset(id: Uuid): Promise<void>;

  /* Asset versions */
  createAssetVersion(input: NewAssetVersion): Promise<AssetVersion>;
  getAssetVersion(id: Uuid): Promise<AssetVersion | null>;
  listAssetVersions(assetId: Uuid): Promise<AssetVersion[]>;
  updateAssetVersion(id: Uuid, patch: Partial<AssetVersion>): Promise<AssetVersion>;

  /* Scenes */
  createScene(input: NewScene): Promise<Scene>;
  getScene(id: Uuid): Promise<Scene | null>;
  listScenes(projectId: Uuid): Promise<Scene[]>;
  /**
   * `expectedVersion`, when given alongside a `doc` write, is checked against
   * the scene's current version; a mismatch throws `SceneConflictError`
   * instead of overwriting. Omit it (as background jobs and restores do) to
   * write unconditionally. Every accepted `doc` write bumps the scene's
   * version and appends a `scene_versions` / `sceneVersions` row.
   */
  updateScene(
    id: Uuid,
    patch: Partial<Pick<Scene, 'name' | 'doc' | 'direction' | 'acceptedAt'>>,
    note?: string,
    expectedVersion?: number,
  ): Promise<Scene>;
  deleteScene(id: Uuid): Promise<void>;

  /** Every retained save of a scene's `doc`, newest first. */
  listSceneVersions(sceneId: Uuid): Promise<SceneVersion[]>;
  getSceneVersion(sceneId: Uuid, versionNumber: number): Promise<SceneVersion | null>;

  /* Jobs */
  createJob(input: NewJob): Promise<Job>;
  getJob(id: Uuid): Promise<Job | null>;
  listJobs(projectId: Uuid, statuses?: JobStatus[]): Promise<Job[]>;
  updateJob(id: Uuid, patch: Partial<Job>): Promise<Job>;
  /**
   * Atomically claim the oldest eligible queued job.
   *
   * Eligible means queued and past its `nextAttemptAt`, if it has one. The
   * claim takes a lease for `leaseMs`; whoever holds it must finish or extend
   * it before it lapses.
   */
  claimNextJob(leaseMs?: number): Promise<Job | null>;
  /** Push the current claim's deadline out. Called while a stage makes progress. */
  extendLease(id: Uuid, leaseMs: number): Promise<void>;
  /**
   * Return jobs whose lease has lapsed to the queue, counting the lost attempt.
   * Jobs already at their attempt limit are failed instead. Returns how many
   * rows were touched.
   */
  reclaimExpiredJobs(): Promise<number>;

  /* Annotations */
  createAnnotation(input: NewAnnotation): Promise<Annotation>;
  getAnnotation(id: Uuid): Promise<Annotation | null>;
  /** Notes on several pieces at once - the studio shows a whole stand's worth. */
  listAnnotations(assetIds: Uuid[], statuses?: AnnotationStatus[]): Promise<Annotation[]>;
  updateAnnotation(id: Uuid, patch: Partial<Annotation>): Promise<Annotation>;
  deleteAnnotation(id: Uuid): Promise<void>;

  /* Rendered output */
  createSceneRender(input: NewSceneRender): Promise<SceneRender>;
  listSceneRenders(sceneId: Uuid): Promise<SceneRender[]>;
  deleteSceneRender(id: Uuid): Promise<void>;

  /* Binary storage */
  putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  getBlob(key: string): Promise<Blob | null>;
  deleteBlob(key: string): Promise<void>;
  /** A URL the browser can fetch. May be signed and time-limited. */
  blobUrl(key: string): Promise<string>;
}
