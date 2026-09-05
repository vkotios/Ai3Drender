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

export interface NewSourceImage extends Omit<SourceImage, 'id' | 'createdAt'> {}
export interface NewAsset extends Omit<FurnitureAsset, 'id' | 'createdAt' | 'updatedAt'> {}
export interface NewAssetVersion extends Omit<AssetVersion, 'id' | 'createdAt'> {}
export interface NewScene {
  projectId: Uuid;
  name: string;
  doc: SceneDoc;
  direction?: Scene['direction'];
}
export interface NewAnnotation
  extends Omit<Annotation, 'id' | 'createdAt' | 'status' | 'resolvedByVersionId'> {}
export interface NewSceneRender extends Omit<SceneRender, 'id' | 'createdAt'> {}
export interface NewJob {
  projectId: Uuid;
  assetId?: Uuid | null;
  kind: JobKind;
  input?: Record<string, unknown>;
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
  updateScene(
    id: Uuid,
    patch: Partial<Pick<Scene, 'name' | 'doc' | 'direction' | 'acceptedAt'>>,
    note?: string,
  ): Promise<Scene>;
  deleteScene(id: Uuid): Promise<void>;

  /* Jobs */
  createJob(input: NewJob): Promise<Job>;
  getJob(id: Uuid): Promise<Job | null>;
  listJobs(projectId: Uuid, statuses?: JobStatus[]): Promise<Job[]>;
  updateJob(id: Uuid, patch: Partial<Job>): Promise<Job>;
  /** Atomically move the oldest queued job to `running` and return it. */
  claimNextJob(): Promise<Job | null>;

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
