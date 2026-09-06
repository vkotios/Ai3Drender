import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  Annotation,
  AnnotationStatus,
  AssetVersion,
  FurnitureAsset,
  FurnitureSpec,
  Job,
  JobStatus,
  MaterialLibraryEntry,
  Project,
  Scene,
  SceneRender,
  SceneShareLink,
  SceneVersion,
  SourceImage,
  Uuid,
} from '@/lib/types';
import { generateShareToken, hashShareToken } from '@/lib/share/token';
import type {
  Blob,
  MaterialLibraryEntryPatch,
  MaterialLibraryUsage,
  NewAnnotation,
  NewAsset,
  NewAssetVersion,
  NewJob,
  NewMaterialLibraryEntry,
  NewSceneRender,
  NewProject,
  NewScene,
  NewShareLink,
  NewSourceImage,
  Store,
} from './store';
import { SceneConflictError, SIGNED_URL_TTL_SECONDS } from './store';

const BUCKET = 'renders';

/**
 * How long a claim is good for. Long enough that a stage polling a slow mesh
 * vendor is not reclaimed mid-flight, since it extends the lease as it
 * reports progress anyway.
 */
const DEFAULT_LEASE_MS = 5 * 60_000;

/* Row <-> domain mapping ----------------------------------------------------
 * Postgres columns are snake_case; the domain model is camelCase. Keeping the
 * translation in one place means no other module has to know about columns.  */

// Rows arrive untyped from the Supabase client, and this module is the
// boundary that turns them into typed domain objects. `any` is confined to
// these mappers rather than leaking past them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  previewPath: r.preview_path ?? null,
  provider: r.provider,
  providerJobId: r.provider_job_id,
  refinement: r.refinement,
  qaResult: r.qa_result ?? null,
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
  clientApproval: r.client_approval ?? 'pending',
  clientApprovalAt: r.client_approval_at,
  clientApprovalName: r.client_approval_name,
  clientApprovalNote: r.client_approval_note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSceneVersion = (r: Row): SceneVersion => ({
  id: r.id,
  sceneId: r.scene_id,
  versionNumber: r.version_number,
  doc: r.doc,
  note: r.note,
  createdAt: r.created_at,
});

const toAnnotation = (r: Row): Annotation => ({
  id: r.id,
  assetId: r.asset_id,
  assetVersionId: r.asset_version_id,
  originVersionId: r.origin_version_id,
  originVersionNumber: Number(r.origin_version_number),
  sceneId: r.scene_id,
  // Rows written before this column existed default to 'point' here too, so
  // an old note still round-trips instead of failing to resolve a shape.
  selectionKind: r.selection_kind ?? 'point',
  point: r.point,
  normal: r.normal,
  partName: r.part_name,
  componentName: r.component_name,
  componentRole: r.component_role,
  anchorDescription: r.anchor_description,
  body: r.body,
  status: r.status,
  source: r.source ?? 'internal',
  clientName: r.client_name,
  resolvedByVersionId: r.resolved_by_version_id,
  staleNote: r.stale_note,
  createdAt: r.created_at,
});

const toShareLink = (r: Row): SceneShareLink => ({
  id: r.id,
  sceneId: r.scene_id,
  createdBy: r.created_by,
  role: r.role,
  label: r.label,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  lastAccessedAt: r.last_accessed_at,
  createdAt: r.created_at,
});

const toSceneRender = (r: Row): SceneRender => ({
  id: r.id,
  sceneId: r.scene_id,
  projectId: r.project_id,
  kind: r.kind,
  path: r.path,
  width: r.width,
  height: r.height,
  samples: r.samples,
  prompt: r.prompt,
  createdAt: r.created_at,
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
  maxAttempts: r.max_attempts ?? 3,
  leaseExpiresAt: r.lease_expires_at ?? null,
  nextAttemptAt: r.next_attempt_at ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMaterialLibraryEntry = (r: Row): MaterialLibraryEntry => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  code: r.code,
  kind: r.kind,
  baseColorHex: r.base_color_hex,
  roughness: Number(r.roughness),
  metalness: Number(r.metalness),
  sheen: Number(r.sheen),
  clearcoat: Number(r.clearcoat),
  finish: r.finish,
  notes: r.notes,
  swatchPath: r.swatch_path,
  archivedAt: r.archived_at,
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
    // Every blob for this project lives under one prefix. A stranded file is
    // better than a project whose row delete failed because storage hiccuped,
    // so this is best-effort: log and move on.
    await this.deleteBlobPrefix(id).catch((cause) => {
      console.error(`[store] deleteProject: failed to remove blobs for project ${id}`, cause);
    });
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
    // Read the key before the row disappears - nothing else records it.
    const existing = await this.db.from('source_images').select('path').eq('id', id).maybeSingle();
    const { error } = await this.db.from('source_images').delete().eq('id', id);
    if (error) throw new Error(`deleteSourceImage: ${error.message}`);
    const path: string | undefined = existing.data?.path;
    if (!path) return;
    await this.deleteBlob(path).catch((cause) => {
      console.error(`[store] deleteSourceImage: failed to remove blob ${path}`, cause);
    });
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
    // Every synthesized view and the reconstructed mesh carry their own
    // storage key on the version row, so no path convention needs guessing -
    // just read them before the cascade takes the versions with the asset.
    const versions = await this.db
      .from('asset_versions')
      .select('views, mesh_path')
      .eq('asset_id', id);

    const { error } = await this.db.from('furniture_assets').delete().eq('id', id);
    if (error) throw new Error(`deleteAsset: ${error.message}`);

    if (versions.error) {
      console.error(`[store] deleteAsset: could not look up blobs for asset ${id}`, versions.error);
      return;
    }
    // A `fromSource` view is not the asset's to delete: analysis points it
    // straight at the project's own source-image blob rather than copying
    // it, and that blob is only ever the source image row's to delete.
    const keys = versions.data.flatMap((v: Row) => [
      ...((v.views ?? []) as { path: string; fromSource: boolean }[])
        .filter((view) => !view.fromSource)
        .map((view) => view.path),
      ...(v.mesh_path ? [v.mesh_path as string] : []),
    ]);
    await Promise.all(
      keys.map((key) =>
        this.deleteBlob(key).catch((cause) => {
          console.error(`[store] deleteAsset: failed to remove blob ${key}`, cause);
        }),
      ),
    );
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
        qa_result: input.qaResult,
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
    if (patch.qaResult !== undefined) update.qa_result = patch.qaResult;
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

  async updateScene(
    id: Uuid,
    patch: Partial<Scene>,
    note = '',
    expectedVersion?: number,
  ): Promise<Scene> {
    const update: Row = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.doc !== undefined) update.doc = patch.doc;
    if (patch.direction !== undefined) update.direction = patch.direction;
    if (patch.acceptedAt !== undefined) update.accepted_at = patch.acceptedAt;
    if (patch.clientApproval !== undefined) update.client_approval = patch.clientApproval;
    if (patch.clientApprovalAt !== undefined) update.client_approval_at = patch.clientApprovalAt;
    if (patch.clientApprovalName !== undefined) update.client_approval_name = patch.clientApprovalName;
    if (patch.clientApprovalNote !== undefined) update.client_approval_note = patch.clientApprovalNote;

    // `version` itself is never set here - a trigger bumps it whenever `doc`
    // actually changes. The `.eq('version', expectedVersion)` below is the
    // optimistic-concurrency check: it is only added for content-changing
    // saves that named the version they loaded, so background jobs and
    // restores (which pass no expectedVersion) always win.
    let query = this.db.from('scenes').update(update).eq('id', id);
    if (patch.doc !== undefined && expectedVersion !== undefined) {
      query = query.eq('version', expectedVersion);
    }
    const res = await query.select().maybeSingle();
    if (res.error) throw new Error(`updateScene: ${res.error.message}`);

    if (!res.data) {
      // Zero rows matched: either the scene is gone, or the version guard
      // above failed. Load the current row to tell the two apart and, for a
      // conflict, hand the caller what the scene looks like now.
      const current = await this.getScene(id);
      if (!current) throw new Error(`scene ${id} not found`);
      throw new SceneConflictError(current);
    }
    const scene = toScene(res.data);

    if (patch.doc !== undefined) {
      await this.db
        .from('scene_versions')
        .insert({ scene_id: id, version_number: scene.version, doc: patch.doc, note });
    }
    return scene;
  }

  async deleteScene(id: Uuid): Promise<void> {
    // Read the owning project before the row disappears - the delete-by-prefix
    // needs it and the cascade would otherwise take it with the scene.
    const existing = await this.db.from('scenes').select('project_id').eq('id', id).maybeSingle();
    const { error } = await this.db.from('scenes').delete().eq('id', id);
    if (error) throw new Error(`deleteScene: ${error.message}`);
    const projectId: string | undefined = existing.data?.project_id;
    if (!projectId) return;
    // One prefix covers every pathtraced/concept render for this scene, plus
    // any viewport capture a crashed concept-render job never cleaned up.
    await this.deleteBlobPrefix(`${projectId}/renders/${id}`).catch((cause) => {
      console.error(`[store] deleteScene: failed to remove render blobs for scene ${id}`, cause);
    });
  }

  async listSceneVersions(sceneId: Uuid): Promise<SceneVersion[]> {
    const res = await this.db
      .from('scene_versions')
      .select('*')
      .eq('scene_id', sceneId)
      .order('version_number', { ascending: false });
    return unwrap('listSceneVersions', res).map(toSceneVersion);
  }

  async getSceneVersion(sceneId: Uuid, versionNumber: number): Promise<SceneVersion | null> {
    const res = await this.db
      .from('scene_versions')
      .select('*')
      .eq('scene_id', sceneId)
      .eq('version_number', versionNumber)
      .maybeSingle();
    if (res.error) throw new Error(`getSceneVersion: ${res.error.message}`);
    return res.data ? toSceneVersion(res.data) : null;
  }

  /* Scene share links -------------------------------------------------------
   * The raw token is hashed before it ever reaches the database - only the
   * caller that just created it sees the clear value. */

  async createShareLink(input: NewShareLink): Promise<{ link: SceneShareLink; token: string }> {
    const token = generateShareToken();
    const res = await this.db
      .from('scene_share_links')
      .insert({
        scene_id: input.sceneId,
        created_by: input.createdBy,
        role: input.role ?? 'commenter',
        label: input.label ?? null,
        expires_at: input.expiresAt ?? null,
        token_hash: hashShareToken(token),
      })
      .select()
      .single();
    return { link: toShareLink(unwrap('createShareLink', res)), token };
  }

  async listShareLinks(sceneId: Uuid): Promise<SceneShareLink[]> {
    const res = await this.db
      .from('scene_share_links')
      .select('*')
      .eq('scene_id', sceneId)
      .order('created_at', { ascending: false });
    return unwrap('listShareLinks', res).map(toShareLink);
  }

  async getShareLink(id: Uuid): Promise<SceneShareLink | null> {
    const res = await this.db.from('scene_share_links').select('*').eq('id', id).maybeSingle();
    if (res.error) throw new Error(`getShareLink: ${res.error.message}`);
    return res.data ? toShareLink(res.data) : null;
  }

  async getShareLinkByToken(token: string): Promise<SceneShareLink | null> {
    const res = await this.db
      .from('scene_share_links')
      .select('*')
      .eq('token_hash', hashShareToken(token))
      .maybeSingle();
    if (res.error) throw new Error(`getShareLinkByToken: ${res.error.message}`);
    return res.data ? toShareLink(res.data) : null;
  }

  async revokeShareLink(id: Uuid): Promise<SceneShareLink> {
    // Idempotent: revoking an already-revoked link keeps its original
    // revocation time rather than sliding it forward.
    const existing = await this.db
      .from('scene_share_links')
      .select('revoked_at')
      .eq('id', id)
      .maybeSingle();
    if (existing.error) throw new Error(`revokeShareLink: ${existing.error.message}`);
    if (!existing.data) throw new Error(`share link ${id} not found`);

    const res = await this.db
      .from('scene_share_links')
      .update({ revoked_at: existing.data.revoked_at ?? new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    return toShareLink(unwrap('revokeShareLink', res));
  }

  async touchShareLink(id: Uuid): Promise<void> {
    const { error } = await this.db
      .from('scene_share_links')
      .update({ last_accessed_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw new Error(`touchShareLink: ${error.message}`);
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
        max_attempts: input.maxAttempts ?? 3,
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
    if (patch.maxAttempts !== undefined) update.max_attempts = patch.maxAttempts;
    if (patch.leaseExpiresAt !== undefined) update.lease_expires_at = patch.leaseExpiresAt;
    if (patch.nextAttemptAt !== undefined) update.next_attempt_at = patch.nextAttemptAt;
    const res = await this.db.from('jobs').update(update).eq('id', id).select().single();
    return toJob(unwrap('updateJob', res));
  }

  async claimNextJob(leaseMs = DEFAULT_LEASE_MS): Promise<Job | null> {
    // Optimistic claim: several workers may select the same row, but the
    // `.eq('status','queued')` guard on the update means only one wins. A
    // loser sees zero rows back and retries with the next candidate.
    const nowIso = new Date().toISOString();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = await this.db
        .from('jobs')
        .select('id, attempts')
        .eq('status', 'queued')
        // A job backing off after a failure is not yet claimable.
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order('created_at')
        .limit(1)
        .maybeSingle();
      if (candidate.error) throw new Error(`claimNextJob: ${candidate.error.message}`);
      if (!candidate.data) return null;

      const attempts = (candidate.data.attempts ?? 0) + 1;
      const claimed = await this.db
        .from('jobs')
        .update({
          status: 'running',
          message: attempts > 1 ? `Retrying (attempt ${attempts})` : 'Starting',
          attempts,
          lease_expires_at: new Date(Date.now() + leaseMs).toISOString(),
          next_attempt_at: null,
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

  async extendLease(id: Uuid, leaseMs: number): Promise<void> {
    // Guarded on `running` so a job already reclaimed from a stalled worker
    // cannot be pulled back by that worker finally waking up.
    const { error } = await this.db
      .from('jobs')
      .update({ lease_expires_at: new Date(Date.now() + leaseMs).toISOString() })
      .eq('id', id)
      .eq('status', 'running');
    if (error) throw new Error(`extendLease: ${error.message}`);
  }

  async reclaimExpiredJobs(): Promise<number> {
    const nowIso = new Date().toISOString();

    const expired = await this.db
      .from('jobs')
      .select('id, attempts, max_attempts')
      .eq('status', 'running')
      .lt('lease_expires_at', nowIso);
    if (expired.error) throw new Error(`reclaimExpiredJobs: ${expired.error.message}`);
    if (!expired.data?.length) return 0;

    let reclaimed = 0;
    for (const row of expired.data) {
      const exhausted = (row.attempts ?? 0) >= (row.max_attempts ?? 3);
      const { data, error } = await this.db
        .from('jobs')
        .update(
          exhausted
            ? {
                status: 'failed',
                message: 'Failed',
                error: `Abandoned by a worker after ${row.attempts} attempt(s)`,
                lease_expires_at: null,
              }
            : {
                status: 'queued',
                message: 'Queued after a worker stopped responding',
                lease_expires_at: null,
                // Straight back in: the lease itself already provided a delay.
                next_attempt_at: null,
              },
        )
        // Still guarded on the expired lease, so a worker that revived and
        // extended its claim between the select and here keeps it.
        .eq('id', row.id)
        .eq('status', 'running')
        .lt('lease_expires_at', nowIso)
        .select('id')
        .maybeSingle();
      if (error) throw new Error(`reclaimExpiredJobs: ${error.message}`);
      if (data) reclaimed += 1;
    }
    return reclaimed;
  }

  /* Annotations ------------------------------------------------------------ */

  async createAnnotation(input: NewAnnotation): Promise<Annotation> {
    const res = await this.db
      .from('annotations')
      .insert({
        asset_id: input.assetId,
        asset_version_id: input.assetVersionId,
        origin_version_id: input.originVersionId,
        origin_version_number: input.originVersionNumber,
        scene_id: input.sceneId,
        selection_kind: input.selectionKind,
        point: input.point,
        normal: input.normal,
        part_name: input.partName,
        component_name: input.componentName,
        component_role: input.componentRole,
        anchor_description: input.anchorDescription,
        body: input.body,
        source: input.source,
        client_name: input.clientName,
        stale_note: input.staleNote,
      })
      .select()
      .single();
    return toAnnotation(unwrap('createAnnotation', res));
  }

  async getAnnotation(id: Uuid): Promise<Annotation | null> {
    const res = await this.db.from('annotations').select('*').eq('id', id).maybeSingle();
    if (res.error) throw new Error(`getAnnotation: ${res.error.message}`);
    return res.data ? toAnnotation(res.data) : null;
  }

  async listAnnotations(assetIds: Uuid[], statuses?: AnnotationStatus[]): Promise<Annotation[]> {
    if (assetIds.length === 0) return [];
    let q = this.db.from('annotations').select('*').in('asset_id', assetIds);
    if (statuses?.length) q = q.in('status', statuses);
    const res = await q.order('created_at');
    return unwrap('listAnnotations', res).map(toAnnotation);
  }

  async updateAnnotation(id: Uuid, patch: Partial<Annotation>): Promise<Annotation> {
    const update: Row = {};
    if (patch.body !== undefined) update.body = patch.body;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.resolvedByVersionId !== undefined) {
      update.resolved_by_version_id = patch.resolvedByVersionId;
    }
    // Carrying a note forward re-points it at the new version and refreshes
    // everything derived from that version's spec.
    if (patch.assetVersionId !== undefined) update.asset_version_id = patch.assetVersionId;
    if (patch.componentName !== undefined) update.component_name = patch.componentName;
    if (patch.componentRole !== undefined) update.component_role = patch.componentRole;
    if (patch.anchorDescription !== undefined) update.anchor_description = patch.anchorDescription;
    if (patch.staleNote !== undefined) update.stale_note = patch.staleNote;
    const res = await this.db.from('annotations').update(update).eq('id', id).select().single();
    return toAnnotation(unwrap('updateAnnotation', res));
  }

  async deleteAnnotation(id: Uuid): Promise<void> {
    const { error } = await this.db.from('annotations').delete().eq('id', id);
    if (error) throw new Error(`deleteAnnotation: ${error.message}`);
  }

  /* Rendered output -------------------------------------------------------- */

  async createSceneRender(input: NewSceneRender): Promise<SceneRender> {
    const res = await this.db
      .from('scene_renders')
      .insert({
        scene_id: input.sceneId,
        project_id: input.projectId,
        kind: input.kind,
        path: input.path,
        width: input.width,
        height: input.height,
        samples: input.samples,
        prompt: input.prompt,
      })
      .select()
      .single();
    return toSceneRender(unwrap('createSceneRender', res));
  }

  async listSceneRenders(sceneId: Uuid): Promise<SceneRender[]> {
    const res = await this.db
      .from('scene_renders')
      .select('*')
      .eq('scene_id', sceneId)
      .order('created_at', { ascending: false });
    return unwrap('listSceneRenders', res).map(toSceneRender);
  }

  async deleteSceneRender(id: Uuid): Promise<void> {
    const { error } = await this.db.from('scene_renders').delete().eq('id', id);
    if (error) throw new Error(`deleteSceneRender: ${error.message}`);
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

  async deleteBlobPrefix(prefix: string): Promise<void> {
    // Refuse the one input that would otherwise sweep the whole bucket -
    // mirrors LocalStore, whose blobPath() rejects an empty key the same way.
    if (!prefix) throw new Error('deleteBlobPrefix: refusing to sweep the whole bucket');
    const keys = await this.listBlobKeys(prefix);
    if (keys.length === 0) return;
    // Storage's remove() takes a flat array of full paths; batch defensively
    // so one very large project cannot blow past whatever limit it has.
    for (let i = 0; i < keys.length; i += 100) {
      const { error } = await this.db.storage.from(BUCKET).remove(keys.slice(i, i + 100));
      if (error) throw new Error(`deleteBlobPrefix ${prefix}: ${error.message}`);
    }
  }

  /**
   * Storage "folders" are only key prefixes - there is no recursive list or
   * delete API - so covering one means walking it by hand: list immediate
   * children, recurse into the ones that are themselves prefixes (a `null`
   * id marks those), and collect every real object's full path.
   */
  async listBlobKeys(prefix = ''): Promise<string[]> {
    const keys: string[] = [];
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const { data, error } = await this.db.storage.from(BUCKET).list(prefix, { limit, offset });
      if (error) throw new Error(`listBlobKeys ${prefix}: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const entry of data) {
        const full = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) {
          keys.push(...(await this.listBlobKeys(full)));
        } else {
          keys.push(full);
        }
      }
      if (data.length < limit) break;
    }
    return keys;
  }

  async blobUrl(key: string): Promise<string> {
    // The bucket is private, so hand out a short-lived signed URL. Long-lived
    // pages (the studio viewport) re-resolve this before it goes stale rather
    // than the TTL being stretched to cover a whole session - see
    // `blobUrlWithExpiry` in lib/db/index.ts and `GET /api/blob-url`.
    const { data, error } = await this.db.storage
      .from(BUCKET)
      .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
    if (error || !data) throw new Error(`blobUrl ${key}: ${error?.message ?? 'no url'}`);
    return data.signedUrl;
  }

  /* Material library --------------------------------------------------------- */

  async createMaterialLibraryEntry(input: NewMaterialLibraryEntry): Promise<MaterialLibraryEntry> {
    const res = await this.db
      .from('material_library_entries')
      .insert({
        owner_id: input.ownerId,
        name: input.name,
        code: input.code,
        kind: input.kind,
        base_color_hex: input.baseColorHex,
        roughness: input.roughness,
        metalness: input.metalness,
        sheen: input.sheen,
        clearcoat: input.clearcoat,
        finish: input.finish,
        notes: input.notes,
        swatch_path: input.swatchPath,
        archived_at: input.archivedAt,
      })
      .select()
      .single();
    return toMaterialLibraryEntry(unwrap('createMaterialLibraryEntry', res));
  }

  async getMaterialLibraryEntry(id: Uuid): Promise<MaterialLibraryEntry | null> {
    const res = await this.db
      .from('material_library_entries')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (res.error) throw new Error(`getMaterialLibraryEntry: ${res.error.message}`);
    return res.data ? toMaterialLibraryEntry(res.data) : null;
  }

  async listMaterialLibraryEntries(
    ownerId: string,
    options?: { includeArchived?: boolean },
  ): Promise<MaterialLibraryEntry[]> {
    let q = this.db.from('material_library_entries').select('*').eq('owner_id', ownerId);
    if (!options?.includeArchived) q = q.is('archived_at', null);
    const res = await q.order('name');
    return unwrap('listMaterialLibraryEntries', res).map(toMaterialLibraryEntry);
  }

  async updateMaterialLibraryEntry(
    id: Uuid,
    patch: MaterialLibraryEntryPatch,
  ): Promise<MaterialLibraryEntry> {
    const update: Row = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.code !== undefined) update.code = patch.code;
    if (patch.kind !== undefined) update.kind = patch.kind;
    if (patch.baseColorHex !== undefined) update.base_color_hex = patch.baseColorHex;
    if (patch.roughness !== undefined) update.roughness = patch.roughness;
    if (patch.metalness !== undefined) update.metalness = patch.metalness;
    if (patch.sheen !== undefined) update.sheen = patch.sheen;
    if (patch.clearcoat !== undefined) update.clearcoat = patch.clearcoat;
    if (patch.finish !== undefined) update.finish = patch.finish;
    if (patch.notes !== undefined) update.notes = patch.notes;
    if (patch.swatchPath !== undefined) update.swatch_path = patch.swatchPath;
    if (patch.archivedAt !== undefined) update.archived_at = patch.archivedAt;
    const res = await this.db
      .from('material_library_entries')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    return toMaterialLibraryEntry(unwrap('updateMaterialLibraryEntry', res));
  }

  async deleteMaterialLibraryEntry(id: Uuid): Promise<void> {
    const { error } = await this.db.from('material_library_entries').delete().eq('id', id);
    if (error) throw new Error(`deleteMaterialLibraryEntry: ${error.message}`);
  }

  async listMaterialLibraryUsage(
    ownerId: string,
    libraryEntryId: Uuid,
  ): Promise<MaterialLibraryUsage[]> {
    const projectsRes = await this.db.from('projects').select('id, name').eq('owner_id', ownerId);
    const projects = unwrap('listMaterialLibraryUsage', projectsRes);
    if (projects.length === 0) return [];
    const projectById = new Map(projects.map((p) => [p.id as string, p]));

    const assetsRes = await this.db
      .from('furniture_assets')
      .select('id, name, project_id, current_version_id')
      .in('project_id', [...projectById.keys()]);
    const assets = unwrap('listMaterialLibraryUsage', assetsRes);
    if (assets.length === 0) return [];
    const assetById = new Map(assets.map((a) => [a.id as string, a]));

    const versionsRes = await this.db
      .from('asset_versions')
      .select('id, asset_id, version_number, spec')
      .in('asset_id', [...assetById.keys()]);
    const versions = unwrap('listMaterialLibraryUsage', versionsRes);

    // A jsonb containment query (`spec->'materials' @> ...`) could filter this
    // server-side, but matching "some element of the array has this
    // libraryEntryId" precisely - without also matching on every other field
    // of that element - is easy to get subtly wrong with `@>`'s per-element
    // semantics. Row counts here are one manufacturer's catalogue against its
    // own asset versions, not a table scan, so filtering in application code
    // (mirroring LocalStore) is simpler and just as correct.
    const usage: MaterialLibraryUsage[] = [];
    for (const row of versions) {
      const asset = assetById.get(row.asset_id as string);
      if (!asset) continue;
      const project = projectById.get(asset.project_id as string);
      if (!project) continue;
      const spec = row.spec as FurnitureSpec;

      for (const material of spec.materials ?? []) {
        if (material.libraryEntryId !== libraryEntryId) continue;
        usage.push({
          projectId: project.id,
          projectName: project.name,
          assetId: asset.id,
          assetName: asset.name,
          assetVersionId: row.id,
          versionNumber: row.version_number,
          isCurrentVersion: asset.current_version_id === row.id,
          materialId: material.id,
          materialName: material.name,
          components: (spec.components ?? [])
            .filter((c) => c.materialId === material.id)
            .map((c) => ({ name: c.name, role: c.role })),
        });
      }
    }
    return usage;
  }
}
