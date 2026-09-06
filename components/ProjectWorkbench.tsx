'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AssetThumbnail } from '@/components/AssetThumbnail';
import { Badge, Button, Empty, Field, Panel, TextInput } from '@/components/ui';
import type {
  AssetStatus,
  AssetVersion,
  FurnitureAsset,
  Job,
  MaterialLibraryEntry,
  Project,
  Scene,
  SourceImage,
} from '@/lib/types';

interface AssetRow {
  asset: FurnitureAsset;
  currentVersion: AssetVersion | null;
  meshUrl: string | null;
  previewUrl: string | null;
}

const BUSY_STATUSES: AssetStatus[] = ['analyzing', 'generating_views', 'reconstructing'];

const STATUS_TONE: Record<AssetStatus, 'neutral' | 'good' | 'bad' | 'busy'> = {
  draft: 'neutral',
  analyzing: 'busy',
  generating_views: 'busy',
  reconstructing: 'busy',
  ready: 'good',
  failed: 'bad',
};

export function ProjectWorkbench({
  project,
  initialImages,
  initialAssets,
  initialScenes,
  imageUrls,
  initialLibraryEntries,
}: {
  project: Project;
  initialImages: SourceImage[];
  initialAssets: AssetRow[];
  initialScenes: Scene[];
  imageUrls: Record<string, string>;
  initialLibraryEntries: MaterialLibraryEntry[];
}) {
  const [images, setImages] = useState(initialImages);
  const [assets, setAssets] = useState(initialAssets);
  const [scenes, setScenes] = useState(initialScenes);
  const [urls, setUrls] = useState(imageUrls);
  const [libraryEntries] = useState(initialLibraryEntries);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pieceName, setPieceName] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const anyBusy = assets.some((row) => BUSY_STATUSES.includes(row.asset.status));

  /** Refresh assets and jobs, and drain the queue while work is outstanding. */
  const poll = useCallback(async () => {
    try {
      await fetch('/api/jobs/tick', { method: 'POST' });
      const [nextAssets, nextJobs] = await Promise.all([
        fetch(`/api/projects/${project.id}/assets`).then((r) => r.json()),
        fetch(`/api/projects/${project.id}/jobs`).then((r) => r.json()),
      ]);
      setAssets(nextAssets);
      setJobs(nextJobs);
    } catch {
      // A dropped poll is not worth surfacing; the next tick retries.
    }
  }, [project.id]);

  // The app drains its own queue, so keep ticking while anything is in flight.
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setInterval(poll, 2500);
    return () => clearInterval(timer);
  }, [anyBusy, poll]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of Array.from(files)) form.append('files', file);
      form.append('role', 'primary');

      const response = await fetch(`/api/projects/${project.id}/images`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Upload failed');
      const saved: SourceImage[] = await response.json();
      setImages((current) => [...current, ...saved]);

      // Local mode serves blobs from a stable route, so URLs are derivable.
      setUrls((current) => ({
        ...current,
        ...Object.fromEntries(
          saved.map((image) => [
            image.id,
            `/api/blob/${image.path.split('/').map(encodeURIComponent).join('/')}`,
          ]),
        ),
      }));
      setSelected((current) => new Set([...current, ...saved.map((i) => i.id)]));
      if (fileInput.current) fileInput.current.value = '';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function reconstruct() {
    setError(null);
    try {
      const response = await fetch(`/api/projects/${project.id}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pieceName, sourceImageIds: [...selected] }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not start');
      setPieceName('');
      setSelected(new Set());
      await poll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start');
    }
  }

  async function createScene() {
    const response = await fetch(`/api/projects/${project.id}/scenes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Stand ${scenes.length + 1}` }),
    });
    if (!response.ok) {
      setError((await response.json()).error ?? 'Could not create a stand');
      return;
    }
    const scene: Scene = await response.json();
    setScenes((current) => [scene, ...current]);
  }

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [deletingImage, setDeletingImage] = useState<string | null>(null);
  async function deleteImage(image: SourceImage) {
    if (!confirm(`Delete "${image.filename}"?`)) return;
    setDeletingImage(image.id);
    try {
      const response = await fetch(`/api/projects/${project.id}/images/${image.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not delete');
      setImages((current) => current.filter((i) => i.id !== image.id));
      setSelected((current) => {
        if (!current.has(image.id)) return current;
        const next = new Set(current);
        next.delete(image.id);
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the photograph');
    } finally {
      setDeletingImage(null);
    }
  }

  async function deleteScene(scene: Scene) {
    if (!confirm(`Delete "${scene.name}"? Every render made from it goes with it.`)) return;
    try {
      const response = await fetch(`/api/scenes/${scene.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not delete');
      setScenes((current) => current.filter((s) => s.id !== scene.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the stand');
    }
  }

  const activeJob = jobs.find((j) => j.status === 'running' || j.status === 'queued');

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <Panel
            title={`Photographs (${images.length})`}
            actions={
              <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? 'Uploading…' : 'Upload'}
              </Button>
            }
          >
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              multiple
              hidden
              onChange={(e) => upload(e.target.files)}
            />

            {images.length === 0 ? (
              <Empty title="No photographs yet">
                Upload shots of one piece at a time. A clear full view plus any detail shots of
                joinery or fabric gives the best reconstruction.
              </Empty>
            ) : (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {images.map((image) => (
                  <li key={image.id} className="group relative">
                    <button
                      onClick={() => toggle(image.id)}
                      className={`block w-full overflow-hidden rounded-md border-2 transition ${
                        selected.has(image.id)
                          ? 'border-amber-500'
                          : 'border-transparent hover:border-shell-600'
                      }`}
                      title={image.filename}
                    >
                      {/* Source photos are user uploads of arbitrary size; the
                          plain img avoids routing them through the optimizer. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={urls[image.id]}
                        alt={image.filename}
                        className="aspect-square w-full bg-shell-850 object-cover"
                      />
                    </button>
                    <button
                      onClick={() => deleteImage(image)}
                      disabled={deletingImage === image.id}
                      title="Delete photograph"
                      className="absolute right-1 top-1 rounded bg-shell-950/80 px-1.5 py-0.5 text-[11px] text-red-300 opacity-0 transition hover:bg-red-950 group-hover:opacity-100 disabled:opacity-100"
                    >
                      {deletingImage === image.id ? '…' : '✕'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={`Pieces (${assets.length})`}>
            {assets.length === 0 ? (
              <Empty title="No pieces reconstructed yet">
                Select photographs above and reconstruct them into a 3D asset.
              </Empty>
            ) : (
              <ul className="space-y-2">
                {assets.map((row) => (
                  <AssetCard
                    key={row.asset.id}
                    row={row}
                    libraryEntries={libraryEntries}
                    onChanged={poll}
                    onDelete={poll}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Reconstruct a piece">
            <div className="space-y-3">
              <Field label="Name" hint="Optional — analysis will name it if you leave this blank.">
                <TextInput
                  value={pieceName}
                  onChange={(e) => setPieceName(e.target.value)}
                  placeholder="Oslo lounge chair"
                />
              </Field>
              <p className="text-xs text-shell-400">
                {selected.size === 0
                  ? 'Select the photographs of one piece.'
                  : `${selected.size} photograph${selected.size === 1 ? '' : 's'} selected.`}
              </p>
              <Button
                variant="primary"
                className="w-full"
                disabled={selected.size === 0}
                onClick={reconstruct}
              >
                Analyze &amp; reconstruct
              </Button>
            </div>
          </Panel>

          {activeJob && (
            <Panel title="In progress">
              <p className="text-sm text-shell-100">{activeJob.message}</p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-shell-800">
                <div
                  className="h-full bg-amber-500 transition-all"
                  style={{ width: `${Math.round(activeJob.progress * 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-shell-400">{activeJob.kind.replace(/_/g, ' ')}</p>
            </Panel>
          )}

          <Panel
            title={`Stands (${scenes.length})`}
            actions={
              <Button size="sm" onClick={createScene}>
                New
              </Button>
            }
          >
            {scenes.length === 0 ? (
              <p className="text-xs text-shell-400">
                A stand is an exhibition environment you place finished pieces into.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {scenes.map((scene) => (
                  <li
                    key={scene.id}
                    className="flex items-center gap-1 rounded-md border border-shell-800 transition hover:border-shell-600 hover:bg-shell-800"
                  >
                    <Link
                      href={`/projects/${project.id}/scenes/${scene.id}`}
                      className="flex flex-1 items-center justify-between gap-2 px-2.5 py-2 text-sm"
                    >
                      <span className="truncate text-shell-100">{scene.name}</span>
                      <span className="text-[11px] text-shell-400">
                        {scene.doc.nodes.length} item{scene.doc.nodes.length === 1 ? '' : 's'}
                      </span>
                    </Link>
                    <button
                      onClick={() => deleteScene(scene)}
                      title="Delete stand"
                      className="px-2 text-[11px] text-shell-500 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** One reconstructed piece, with its spec summary and a refinement box. */
function AssetCard({
  row,
  libraryEntries,
  onChanged,
  onDelete,
}: {
  row: AssetRow;
  libraryEntries: MaterialLibraryEntry[];
  onChanged: () => void;
  onDelete: () => void;
}) {
  const { asset, currentVersion, meshUrl, previewUrl } = row;
  const [instruction, setInstruction] = useState('');
  const [rebuild, setRebuild] = useState(false);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function refine() {
    if (!instruction.trim()) return;
    setSending(true);
    try {
      await fetch(`/api/assets/${asset.id}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, rebuildMesh: rebuild }),
      });
      setInstruction('');
      setOpen(false);
      await onChanged();
    } finally {
      setSending(false);
    }
  }

  async function accept() {
    if (!currentVersion) return;
    await fetch(`/api/assets/${asset.id}/versions/${currentVersion.id}/accept`, { method: 'POST' });
    await onChanged();
  }

  async function bindMaterial(materialId: string, libraryEntryId: string) {
    if (!currentVersion || !libraryEntryId) return;
    await fetch(
      `/api/assets/${asset.id}/versions/${currentVersion.id}/materials/${materialId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ libraryEntryId }),
      },
    );
    await onChanged();
  }

  async function promoteMaterial(materialId: string) {
    if (!currentVersion) return;
    await fetch(
      `/api/assets/${asset.id}/versions/${currentVersion.id}/materials/${materialId}/promote`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    await onChanged();
  }

  async function remove() {
    if (!confirm(`Delete "${asset.name || 'this piece'}"? Every version and its notes go with it.`)) {
      return;
    }
    setDeleting(true);
    try {
      const response = await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      onDelete();
    } catch {
      setDeleting(false);
    }
  }

  return (
    <li className="rounded-lg border border-shell-800 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <AssetThumbnail
            key={currentVersion?.id ?? asset.id}
            assetId={asset.id}
            versionId={currentVersion?.id ?? ''}
            meshUrl={currentVersion ? meshUrl : null}
            previewUrl={currentVersion ? previewUrl : null}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-shell-100">
                {asset.name || 'Identifying…'}
              </span>
              <Badge tone={STATUS_TONE[asset.status]}>{asset.status.replace(/_/g, ' ')}</Badge>
              {currentVersion?.acceptedAt && <Badge tone="good">accepted</Badge>}
              {currentVersion?.qaResult && <QaBadge qaResult={currentVersion.qaResult} />}
            </div>
            {currentVersion && (
              <p className="mt-1 text-xs text-shell-400">
                v{currentVersion.versionNumber} · {currentVersion.spec.dimensions.widthMm} ×{' '}
                {currentVersion.spec.dimensions.depthMm} × {currentVersion.spec.dimensions.heightMm} mm ·{' '}
                {currentVersion.spec.dimensionConfidence} dimensions · {currentVersion.provider}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {currentVersion?.meshPath && !currentVersion.acceptedAt && (
            <Button size="sm" onClick={accept}>
              Accept
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            Refine
          </Button>
          <Button size="sm" variant="danger" onClick={remove} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>

      {currentVersion && (
        <ul className="mt-2 space-y-1">
          {currentVersion.spec.materials.map((material) => (
            <li
              key={material.id}
              className="flex flex-wrap items-center gap-1.5 rounded border border-shell-800 px-1.5 py-1 text-[11px] text-shell-300"
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: material.baseColorHex }}
              />
              <span title={`${material.finish} · roughness ${material.roughness}`}>
                {material.name}
              </span>
              {material.libraryEntryId ? (
                <Badge tone="good">library</Badge>
              ) : material.invented ? (
                <Badge tone="warn">new</Badge>
              ) : null}

              {!currentVersion.acceptedAt && (
                <span className="ml-auto flex items-center gap-1">
                  {material.invented && !material.libraryEntryId && (
                    <Button size="sm" variant="ghost" onClick={() => promoteMaterial(material.id)}>
                      Promote
                    </Button>
                  )}
                  {libraryEntries.length > 0 && (
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const value = e.target.value;
                        e.target.value = '';
                        if (value) bindMaterial(material.id, value);
                      }}
                      className="rounded border border-shell-700 bg-shell-850 px-1 py-0.5 text-[11px] text-shell-200 focus:border-shell-400 focus:outline-none"
                    >
                      <option value="" disabled>
                        Bind to…
                      </option>
                      {libraryEntries.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 space-y-2 border-t border-shell-800 pt-3">
          <TextInput
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Make the frame darker walnut and lower the seat by 30mm"
          />
          <label className="flex items-center gap-2 text-xs text-shell-300">
            <input
              type="checkbox"
              checked={rebuild}
              onChange={(e) => setRebuild(e.target.checked)}
              className="accent-shell-100"
            />
            Rebuild the mesh too (slower, uses a reconstruction credit)
          </label>
          <Button size="sm" variant="primary" onClick={refine} disabled={sending || !instruction.trim()}>
            {sending ? 'Queuing…' : 'Create new version'}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Perceptual QA verdict, badge-sized: whether the reconstructed mesh actually
 * looks like the source photos (see lib/ai/gemini.ts's evaluateReconstruction).
 *
 * Always a soft signal - it never blocks Accept/Refine/Delete above, and an
 * offline result (no GEMINI_API_KEY configured) says exactly that rather than
 * implying a real check passed.
 */
function QaBadge({ qaResult }: { qaResult: NonNullable<AssetVersion['qaResult']> }) {
  if (qaResult.source === 'offline') {
    return (
      <span title="No GEMINI_API_KEY configured, so the mesh was not checked against the photos.">
        <Badge>qa: offline</Badge>
      </span>
    );
  }

  const tone = qaResult.score >= 80 ? 'good' : qaResult.score >= 50 ? 'warn' : 'bad';
  const title =
    qaResult.issues.length > 0
      ? `Fidelity vs. source photos: ${qaResult.score}/100 - ${qaResult.issues.join('; ')}`
      : `Fidelity vs. source photos: ${qaResult.score}/100 - no issues flagged`;

  return (
    <span title={title}>
      <Badge tone={tone}>qa: {qaResult.score}</Badge>
    </span>
  );
}
