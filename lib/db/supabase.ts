import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  AssetVersion,
  FurnitureAsset,
  Job,
  JobStatus,
  Project,
  Scene,
  SourceImage,
  Uuid,
} from '@/lib/types';
import type {
  Blob,
  NewAsset,
  NewAssetVersion,
  NewJob,
  NewProject,
  NewScene,
  NewSourceImage,
  Store,
} from './store';

const BUCKET = 'renders';

/* Row <-> domain mapping ----------------------------------------------------
 * Postgres columns are snake_case; the domain model is camelCase. Keeping the
 * translation in one place means no other module has to know about columns.  */

type Row = Record<string, any>;

const toProject = (r: Row): Project => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  client: r.client,
  brief: r.brief,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSourceImage = (r: Row): SourceImage => ({
  id: r.id,
  projectId: r.project_id,
  path: r.path,
  filename: r.filename,
  mimeType: r.mime_type,
  byteSize: Number(r.byte_size),
  role: r.role,
  createdAt: r.created_at,
});

const toAsset = (r: Row): FurnitureAsset => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  status: r.status,
  currentVersionId: r.current_version_id,
  sourceImageIds: r.source_image_ids ?? [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toVersion = (r: Row): AssetVersion => ({
  id: r.id,
  assetId: r.asset_id,
  versionNumber: r.version_number,
  label: r.label,
  parentVersionId: r.parent_version_id,
  spec: r.spec,
  views: r.views ?? [],
  meshPath: r.mesh_path,
  meshExtentMm: r.mesh_extent_mm === null ? null : Number(r.mesh_extent_mm),
  previewPath: r.preview_path,
  provider: r.provider,
  providerJobId: r.provider_job_id,
  refinement: r.refinement,
  acceptedAt: r.accepted_at,
  createdAt: r.created_at,
});

const toScene = (r: Row): Scene => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  doc: r.doc,
  direction: r.direction,
  acceptedAt: r.accepted_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toJob = (r: Row): Job => ({
  id: r.id,
  projectId: r.project_id,
  assetId: r.asset_id,
  kind: r.kind,
  status: r.status,
  progress: Number(r.progress),
  message: r.message,
  error: r.error,
  input: r.input ?? {},
  output: r.output,
  attempts: r.attempts,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Narrow a PostgrestError into something with useful context attached. */
function unwrap<T>(what: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no rows returned`);
  return res.data;
}

export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;

  constructor(private readonly db: SupabaseClient) {}

  /* Projects --------------------------------------------------------------- */

  async listProjects(ownerId: string): Promise<Project[]> {
    const res = await this.db
      .from('projects')
      .select('*')
      .eq('owner_id', ownerId)
      .order('updated_at', { ascending: false });
    return unwrap('listProjects', res).map(toProject);
  }

  async createProject(input: NewProject): Promise<Project> {
    const res = await this.db
      .from('projects')
      .insert({
        owner_id: input.ownerId,
        name: input.name,
        client: input.client ?? null,
        brief: input.brief ?? null,
      })
      .select()
      .single();
    return toProject(unwrap('createProject', res));
  }

  async getProject(id: Uuid): Promise<Project | null> {
    const res = await this.db.from('projects').select('*').eq('id', id).maybeSingle();
    if (res.error) throw new Error(`getProject: ${res.error.message}`);
    return res.data ? toProject(res.data) : null;
  }

  async updateProject(id: Uuid, patch: Partial<Project>): Promise<Project> {
    const res = await this.db
      .from('projects')
      .update({ name: patch.name, client: patch.client, brief: patch.brief })
      .eq('id', id)
      .select()
      .single();
    return toProject(unwrap('updateProject', res));
  }

  async deleteProject(id: Uuid): Promise<void> {
    // Every child table cascades from projects, so one delete is enough.
    const { error } = await this.db.from('projects').delete().eq('id', id);
    if (error) throw new Error(`deleteProject: ${error.message}`);
  }

  /* Source images ---------------------------------------------------------- */

  async addSourceImage(input: NewSourceImage): Promise<SourceImage> {
    const res = await this.db
      .from('source_images')
      .insert({
        project_id: input.projectId,
        path: input.path,
        filename: input.filename,
        mime_type: input.mimeType,
        byte_size: input.byteSize,
        role: input.role,
      })
      .select()
      .single();
    return toSourceImage(unwrap('addSourceImage', res));
  }

  async listSourceImages(projectId: Uuid): Promise<SourceImage[]> {
    const res = await this.db
      .from('source_images')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at');
    return unwrap('listSourceImages', res).map(toSourceImage);
  }

  async getSourceImages(ids: Uuid[]): Promise<SourceImage[]> {
    if (ids.length === 0) return [];
    const res = await this.db.from('source_images').select('*').in('id', ids);
    const rows = unwrap('getSourceImages', res).map(toSourceImage);
    // `in` does not preserve order, but the caller's order is meaningful.
    return ids
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is SourceImage => Boolean(r));
  }

  async deleteSourceImage(id: Uuid): Promise<void> {
    const { error } = await this.db.from('source_images').delete().eq('id', id);
    if (error) throw new Error(`deleteSourceImage: ${error.message}`);
  }

  /* Assets ----------------------------------------------------------------- */

  async createAsset(input: NewAsset): Promise<FurnitureAsset> {
    const res = await this.db
      .from('furniture_assets')
      .insert({
        project_id: input.projectId,
        name: input.name,
        status: input.status,
        current_version_id: input.currentVersionId,
        source_image_ids: input.sourceImageIds,
      })
      .select()
      .single();
    return toAsset(unwrap('createAsset', res));
  }

  async getAsset(id: Uuid): Promise<FurnitureAsset | null> {
    const res = await this.db.from('furniture_assets').select('*').eq('id', id).maybeSingle();
    if (res.error) throw new Error(`getAsset: ${res.error.message}`);
    return res.data ? toAsset(res.data) : null;
  }

  async listAssets(projectId: Uuid): Promise<FurnitureAsset[]> {
    const res = await this.db
      .from('furniture_assets')
      .select('*')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false });
    return unwrap('listAssets', res).map(toAsset);
  }

  async updateAsset(id: Uuid, patch: Partial<FurnitureAsset>): Promise<FurnitureAsset> {
    const update: Row = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.currentVersionId !== undefined) update.current_version_id = patch.currentVersionId;
    const res = await this.db.from('furniture_assets').update(update).eq('id', id).select().single();
    return toAsset(unwrap('updateAsset', res));
  }

  async deleteAsset(id: Uuid): Promise<void> {
    const { error } = await this.db.from('furniture_assets').delete().eq('id', id);
    if (error) throw new Error(`deleteAsset: ${error.message}`);
  }

  /* Asset versions --------------------------------------------------------- */

  async createAssetVersion(input: NewAssetVersion): Promise<AssetVersion> {
    const res = await this.db
      .from('asset_versions')
      .insert({
        asset_id: input.assetId,
        version_number: input.versionNumber,
        label: input.label,
        parent_version_id: input.parentVersionId,
        spec: input.spec,
        views: input.views,
        mesh_path: input.meshPath,
        mesh_extent_mm: input.meshExtentMm,
        preview_path: input.previewPath,
        provider: input.provider,
        provider_job_id: input.providerJobId,
        refinement: input.refinement,
        accepted_at: input.acceptedAt,
      })
      .select()
      .single();
    return toVersion(unwrap('createAssetVersion', res));
  }

  async getAssetVersion(id: Uuid): Promise<AssetVersion | null> {
    const res = await this.db.from('asset_versions').select('*').eq('id', id).maybeSingle();
    if (res.error) throw new Error(`getAssetVersion: ${res.error.message}`);
    return res.data ? toVersion(res.data) : null;
  }

  async listAssetVersions(assetId: Uuid): Promise<AssetVersion[]> {
    const res = await this.db
      .from('asset_versions')
      .select('*')
      .eq('asset_id', assetId)
      .order('version_number', { ascending: false });
    return unwrap('listAssetVersions', res).map(toVersion);
  }

  async updateAssetVersion(id: Uuid, patch: Partial<AssetVersion>): Promise<AssetVersion> {
    const update: Row = {};
    if (patch.label !== undefined) update.label = patch.label;
    if (patch.spec !== undefined) update.spec = patch.spec;
    if (patch.views !== undefined) update.views = patch.views;
    if (patch.meshPath !== undefined) update.mesh_path = patch.meshPath;
    if (patch.meshExtentMm !== undefined) update.mesh_extent_mm = patch.meshExtentMm;
    if (patch.previewPath !== undefined) update.preview_path = patch.previewPath;
    if (patch.provider !== undefined) update.provider = patch.provider;
    if (patch.providerJobId !== undefined) update.provider_job_id = patch.providerJobId;
    if (patch.refinement !== undefined) update.refinement = patch.refinement;
    if (patch.acceptedAt !== undefined) update.accepted_at = patch.acceptedAt;
    const res = await this.db.from('asset_versions').update(update).eq('id', id).select().single();
    return toVersion(unwrap('updateAssetVersion', res));
  }

  /* Scenes ----------------------------------------------------------------- */

  async createScene(input: NewScene): Promise<Scene> {
    const res = await this.db
      .from('scenes')
      .insert({
        project_id: input.projectId,
        name: input.name,
        doc: input.doc,
        direction: input.direction ?? null,
      })
      .select()
      .single();
    const scene = toScene(unwrap('createScene', res));
    await this.db
      .from('scene_versions')
      .insert({ scene_id: scene.id, version_number: 1, doc: scene.doc, note: 'created' });
    return scene;
  }

  async getScene(id: Uuid): Promise<Scene | null> {
    const res = await this.db.from('scenes').select('*').eq('id', id).maybeSingle();
    if (res.error) throw new Error(`getScene: ${res.error.message}`);
    return res.data ? toScene(res.data) : null;
  }

  async listScenes(projectId: Uuid): Promise<Scene[]> {
    const res = await this.db
      .from('scenes')
      .select('*')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false });
    return unwrap('listScenes', res).map(toScene);
  }

  async updateScene(id: Uuid, patch: Partial<Scene>, note = ''): Promise<Scene> {
    const update: Row = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.doc !== undefined) update.doc = patch.doc;
    if (patch.direction !== undefined) update.direction = patch.direction;
    if (patch.acceptedAt !== undefined) update.accepted_at = patch.acceptedAt;
    const res = await this.db.from('scenes').update(update).eq('id', id).select().single();
    const scene = toScene(unwrap('updateScene', res));

    if (patch.doc !== undefined) {
      const latest = await this.db
        .from('scene_versions')
        .select('version_number')
        .eq('scene_id', id)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      const next = (latest.data?.version_number ?? 0) + 1;
      await this.db
        .from('scene_versions')
        .insert({ scene_id: id, version_number: next, doc: patch.doc, note });
    }
    return scene;
  }

  async deleteScene(id: Uuid): Promise<void> {
    const { error } = await this.db.from('scenes').delete().eq('id', id);
    if (error) throw new Error(`deleteScene: ${error.message}`);
  }

  /* Jobs ------------------------------------------------------------------- */

  async createJob(input: NewJob): Promise<Job> {
    const res = await this.db
      .from('jobs')
      .insert({
        project_id: input.projectId,
        asset_id: input.assetId ?? null,
        kind: input.kind,
        input: input.input ?? {},
        message: 'Queued',
      })
      .select()
      .single();
    return toJob(unwrap('createJob', res));
  }

  async getJob(id: Uuid): Promise<Job | null> {
    const res = await this.db.from('jobs').select('*').eq('id', id).maybeSingle();
    if (res.error) throw new Error(`getJob: ${res.error.message}`);
    return res.data ? toJob(res.data) : null;
  }

  async listJobs(projectId: Uuid, statuses?: JobStatus[]): Promise<Job[]> {
    let q = this.db.from('jobs').select('*').eq('project_id', projectId);
    if (statuses?.length) q = q.in('status', statuses);
    const res = await q.order('created_at', { ascending: false });
    return unwrap('listJobs', res).map(toJob);
  }

  async updateJob(id: Uuid, patch: Partial<Job>): Promise<Job> {
    const update: Row = {};
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.progress !== undefined) update.progress = patch.progress;
    if (patch.message !== undefined) update.message = patch.message;
    if (patch.error !== undefined) update.error = patch.error;
    if (patch.output !== undefined) update.output = patch.output;
    if (patch.attempts !== undefined) update.attempts = patch.attempts;
    const res = await this.db.from('jobs').update(update).eq('id', id).select().single();
    return toJob(unwrap('updateJob', res));
  }

  async claimNextJob(): Promise<Job | null> {
    // Optimistic claim: several workers may select the same row, but the
    // `.eq('status','queued')` guard on the update means only one wins. A
    // loser sees zero rows back and retries with the next candidate.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = await this.db
        .from('jobs')
        .select('id, attempts')
        .eq('status', 'queued')
        .order('created_at')
        .limit(1)
        .maybeSingle();
      if (candidate.error) throw new Error(`claimNextJob: ${candidate.error.message}`);
      if (!candidate.data) return null;

      const claimed = await this.db
        .from('jobs')
        .update({
          status: 'running',
          message: 'Starting',
          attempts: (candidate.data.attempts ?? 0) + 1,
        })
        .eq('id', candidate.data.id)
        .eq('status', 'queued')
        .select()
        .maybeSingle();
      if (claimed.error) throw new Error(`claimNextJob: ${claimed.error.message}`);
      if (claimed.data) return toJob(claimed.data);
    }
    return null;
  }

  /* Blobs ------------------------------------------------------------------ */

  async putBlob(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const { error } = await this.db.storage
      .from(BUCKET)
      .upload(key, bytes, { contentType, upsert: true });
    if (error) throw new Error(`putBlob ${key}: ${error.message}`);
    return key;
  }

  async getBlob(key: string): Promise<Blob | null> {
    const { data, error } = await this.db.storage.from(BUCKET).download(key);
    if (error || !data) return null;
    return {
      bytes: new Uint8Array(await data.arrayBuffer()),
      contentType: data.type || 'application/octet-stream',
    };
  }

  async deleteBlob(key: string): Promise<void> {
    const { error } = await this.db.storage.from(BUCKET).remove([key]);
    if (error) throw new Error(`deleteBlob ${key}: ${error.message}`);
  }

  async blobUrl(key: string): Promise<string> {
    // The bucket is private, so hand out a short-lived signed URL. One hour is
    // long enough for a studio session without leaving links usable forever.
    const { data, error } = await this.db.storage.from(BUCKET).createSignedUrl(key, 3600);
    if (error || !data) throw new Error(`blobUrl ${key}: ${error?.message ?? 'no url'}`);
    return data.signedUrl;
  }
}
