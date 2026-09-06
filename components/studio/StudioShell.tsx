'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';

import { Badge, Button } from '@/components/ui';
import {
  EXPORT_FORMATS,
  downloadBlob,
  exportScene,
  slugify,
  type ExportFormat,
} from '@/lib/studio/export';
import { useStudio, type LoadedVersion, type StudioMode } from '@/lib/studio/store';
import type { Annotation, ClientApproval, Project, Scene } from '@/lib/types';

import { AnnotationPanel } from './AnnotationPanel';
import { Inspector } from './Inspector';
import { RenderPanel, type StoredRender } from './RenderPanel';
import { Outliner } from './Outliner';
import { SharePanel } from './SharePanel';
import type { GizmoMode, RenderMode, RenderSettings } from './StudioCanvas';
import { VersionHistory } from './VersionHistory';

// WebGL cannot render on the server, and drei's Environment pulls its HDRIs at
// runtime, so the viewport is client-only.
const StudioCanvas = dynamic(() => import('./StudioCanvas').then((m) => m.StudioCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-shell-400">
      Starting the viewport…
    </div>
  ),
});

export function StudioShell({
  project,
  scene,
  versions,
  available,
  annotations,
  initialRenders,
  conceptAvailable,
}: {
  project: Project;
  scene: Scene;
  versions: LoadedVersion[];
  available: LoadedVersion[];
  annotations: Annotation[];
  initialRenders: StoredRender[];
  /** False when GEMINI_API_KEY is unset, so the concept button explains itself. */
  conceptAvailable: boolean;
}) {
  const load = useStudio((s) => s.load);
  const doc = useStudio((s) => s.doc);
  const dirty = useStudio((s) => s.dirty);
  const markSaved = useStudio((s) => s.markSaved);
  const mode = useStudio((s) => s.mode);
  const setMode = useStudio((s) => s.setMode);
  const selectionMode = useStudio((s) => s.selectionMode);
  const setAnnotations = useStudio((s) => s.setAnnotations);

  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [panel, setPanel] = useState<'inspect' | 'render' | 'history'>('inspect');
  const [renderMode, setRenderMode] = useState<RenderMode>('preview');
  const [renderSettings, setRenderSettings] = useState<RenderSettings>({
    bounces: 5,
    maxSamples: 256,
    resolutionScale: 1,
  });
  const [samples, setSamples] = useState(0);
  const [converged, setConverged] = useState(false);
  const [renders, setRenders] = useState<StoredRender[]>(initialRenders);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [clientApproval, setClientApproval] = useState(scene.clientApproval);
  // Set when a save is rejected because the scene moved on since it was
  // loaded - `current` is the server's own record of where it moved to.
  const [conflict, setConflict] = useState<{ current: Scene } | null>(null);
  const exportRoot = useRef<THREE.Group | null>(null);

  // Seeded in an effect rather than during render: the studio store is a
  // module singleton, and writing to it while server-rendering would leak one
  // request's scene into another's. The asides show a skeleton until it lands.
  useEffect(() => {
    // Seed the store with everything the scene references plus every finished
    // piece, so staging a new one needs no extra fetch.
    const seen = new Map(versions.map((v) => [v.version.id, v]));
    for (const v of available) if (!seen.has(v.version.id)) seen.set(v.version.id, v);
    load(scene, [...seen.values()], annotations);
  }, [load, scene, versions, available, annotations]);

  const onExportRootReady = useCallback((root: THREE.Group | null) => {
    exportRoot.current = root;
  }, []);

  const onCanvasReady = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
  }, []);

  // Called every frame while tracing. The tracer reports fractional samples
  // while it warms up at low resolution, so round for display and only commit
  // to state when the whole number actually changes.
  const onSamples = useCallback((next: number, done: boolean) => {
    // Quantise to a tenth: enough resolution to show progress below the first
    // full sample, without re-rendering the panel on every frame.
    const value = Math.round(next * 10) / 10;
    setSamples((current) => (current === value ? current : value));
    setConverged((current) => (current === done ? current : done));
  }, []);

  /** Read the current frame out of the WebGL canvas as a PNG. */
  const captureCanvas = useCallback(async (): Promise<Blob> => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error('The viewport is not ready');
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not read the viewport'))),
        'image/png',
      ),
    );
  }, []);

  const saveRender = useCallback(async () => {
    setBusy('Saving frame');
    setError(null);
    try {
      const blob = await captureCanvas();
      const form = new FormData();
      form.append('file', blob, 'render.png');
      form.append('samples', String(samples));
      form.append('width', String(canvasRef.current?.width ?? 0));
      form.append('height', String(canvasRef.current?.height ?? 0));

      const response = await fetch(`/api/scenes/${scene.id}/renders`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not save');
      const saved: StoredRender = await response.json();
      setRenders((current) => [saved, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the frame');
    } finally {
      setBusy(null);
    }
  }, [captureCanvas, samples, scene.id]);

  const conceptRender = useCallback(
    async (instruction: string) => {
      setBusy('Rendering concept');
      setError(null);
      try {
        const blob = await captureCanvas();
        const form = new FormData();
        form.append('file', blob, 'capture.png');
        form.append('instruction', instruction);
        form.append('width', String(canvasRef.current?.width ?? 0));
        form.append('height', String(canvasRef.current?.height ?? 0));

        const queued = await fetch(`/api/scenes/${scene.id}/concept`, {
          method: 'POST',
          body: form,
        });
        if (!queued.ok) throw new Error((await queued.json()).error ?? 'Could not queue');

        await fetch('/api/jobs/tick', { method: 'POST' });
        const listed = await fetch(`/api/scenes/${scene.id}/renders`);
        if (listed.ok) setRenders(await listed.json());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Concept render failed');
      } finally {
        setBusy(null);
      }
    },
    [captureCanvas, scene.id],
  );

  /**
   * Re-pull notes after a revision round.
   *
   * Deliberately keyed off the pieces loaded in this session rather than the
   * saved scene: staging is not persisted until Save, so asking the server
   * what is on the stand would come back empty and wipe the panel.
   */
  const refresh = useCallback(async () => {
    const assetIds = [
      ...new Set(Object.values(useStudio.getState().versions).map((v) => v.version.assetId)),
    ];
    const lists = await Promise.all(
      assetIds.map((id) =>
        fetch(`/api/assets/${id}/annotations`).then((r) => (r.ok ? r.json() : [])),
      ),
    );
    setAnnotations(lists.flat());
  }, [setAnnotations]);

  /**
   * `force` skips the version check entirely - used only for the "overwrite
   * anyway" choice in the conflict dialog below, once the user has seen what
   * they'd be overwriting and chosen to anyway.
   */
  const save = useCallback(
    async (force = false) => {
      const state = useStudio.getState();
      const current = state.doc;
      const loaded = state.scene;
      if (!current || !loaded) return;
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(`/api/scenes/${scene.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            doc: current,
            note: 'edited in studio',
            // The version this edit was staged on top of - the server
            // rejects the write if someone else has saved since.
            expectedVersion: loaded.version,
            force,
          }),
        });
        if (response.status === 409) {
          const body = (await response.json()) as { current: Scene };
          setConflict({ current: body.current });
          return;
        }
        if (!response.ok) throw new Error((await response.json()).error ?? 'Save failed');
        markSaved(await response.json());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Save failed');
      } finally {
        setSaving(false);
      }
    },
    [scene.id, markSaved],
  );

  /** "Reload" in the conflict dialog: drop local edits, pull the current save. */
  const reloadFromServer = useCallback(async () => {
    setConflict(null);
    const refreshed = await fetch(`/api/scenes/${scene.id}`).then((r) => r.json());
    load(refreshed.scene, refreshed.versions, refreshed.annotations);
  }, [scene.id, load]);

  /** "Overwrite anyway" in the conflict dialog: save over the other write. */
  const overwriteAnyway = useCallback(() => {
    setConflict(null);
    void save(true);
  }, [save]);

  // Warn before losing unsaved staging work.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!exportRoot.current) {
        setError('The viewport is still loading.');
        return;
      }
      setBusy(`Exporting ${format.toUpperCase()}`);
      setError(null);
      try {
        const { blob, extension } = await exportScene(exportRoot.current, format);
        downloadBlob(blob, `${slugify(project.name)}-${slugify(scene.name)}.${extension}`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Export failed');
      } finally {
        setBusy(null);
      }
    },
    [project.name, scene.name],
  );

  const artDirect = useCallback(async () => {
    setBusy('Art-directing the stand');
    setError(null);
    try {
      const response = await fetch(`/api/scenes/${scene.id}/direct`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
      await fetch('/api/jobs/tick', { method: 'POST' });
      // The stage rewrites the scene document, so reload it wholesale.
      const refreshed = await fetch(`/api/scenes/${scene.id}`).then((r) => r.json());
      load(refreshed.scene, refreshed.versions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Art direction failed');
    } finally {
      setBusy(null);
    }
  }, [scene.id, load]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-shell-800 bg-shell-900 px-4 py-2.5">
        <Link
          href={`/projects/${project.id}`}
          className="text-sm text-shell-400 transition hover:text-shell-100"
        >
          ← {project.name}
        </Link>
        <span className="text-shell-700">/</span>
        <h1 className="text-sm font-medium text-shell-100">{scene.name}</h1>
        {clientApproval !== 'pending' && <ClientApprovalBadge status={clientApproval} />}
        {dirty && <Badge tone="warn">Unsaved</Badge>}
        {busy && <Badge tone="busy">{busy}…</Badge>}
        {error && (
          <span className="truncate text-xs text-red-400" title={error}>
            {error}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <div className="mr-1 flex rounded-md border border-shell-700 p-0.5">
            {(['layout', 'comment'] as StudioMode[]).map((value) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={`rounded px-2 py-1 text-[11px] capitalize transition ${
                  mode === value ? 'bg-shell-700 text-shell-100' : 'text-shell-400 hover:text-shell-100'
                }`}
              >
                {value}
              </button>
            ))}
          </div>

          {mode === 'layout' && renderMode === 'preview' && (
            <div className="mr-1 flex rounded-md border border-shell-700 p-0.5">
              {(['translate', 'rotate', 'scale'] as GizmoMode[]).map((value) => (
                <button
                  key={value}
                  onClick={() => setGizmoMode(value)}
                  className={`rounded px-2 py-1 text-[11px] capitalize transition ${
                    gizmoMode === value
                      ? 'bg-shell-700 text-shell-100'
                      : 'text-shell-400 hover:text-shell-100'
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          )}

          <Button
            size="sm"
            variant={panel === 'render' ? 'primary' : 'default'}
            onClick={() => setPanel((p) => (p === 'render' ? 'inspect' : 'render'))}
          >
            Render
          </Button>

          <Button
            size="sm"
            variant={panel === 'history' ? 'primary' : 'default'}
            onClick={() => setPanel((p) => (p === 'history' ? 'inspect' : 'history'))}
          >
            History
          </Button>

          <Button size="sm" onClick={artDirect} disabled={Boolean(busy)}>
            Art-direct
          </Button>

          <div className="relative">
            <Button size="sm" onClick={() => setSharePanelOpen((v) => !v)}>
              Share ▾
            </Button>
            {sharePanelOpen && (
              <SharePanel
                sceneId={scene.id}
                onClose={() => {
                  setSharePanelOpen(false);
                  // The client may have signed off since this page loaded -
                  // pick that up whenever the owner closes the link panel.
                  fetch(`/api/scenes/${scene.id}`)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((data) => data?.scene && setClientApproval(data.scene.clientApproval))
                    .catch(() => {});
                }}
              />
            )}
          </div>

          <ExportMenu onExport={handleExport} disabled={Boolean(busy)} />

          <Button size="sm" variant="primary" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-shell-800 bg-shell-950 p-3">
          {doc ? <Outliner available={available} /> : <PanelSkeleton rows={3} />}
        </aside>

        <main className="relative min-w-0 flex-1 bg-shell-900">
          {doc && (
            <StudioCanvas
              doc={doc}
              gizmoMode={gizmoMode}
              renderMode={renderMode}
              renderSettings={renderSettings}
              onSamples={onSamples}
              onExportRootReady={onExportRootReady}
              onCanvasReady={onCanvasReady}
            />
          )}
          <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-shell-950/80 px-3 py-1 text-[11px] text-shell-400">
            {renderMode === 'pathtrace'
              ? `Path tracing — ${formatSamples(samples)} sample${samples === 1 ? '' : 's'}${
                  converged ? ' · converged' : ''
                }`
              : mode === 'comment'
                ? selectionMode === 'part'
                  ? 'Click a piece to note the whole part it belongs to · hold Shift for one exact point'
                  : selectionMode === 'freehand'
                    ? 'Click and drag across a piece to draw a stroke, then release to pin a note to it'
                    : 'Click anywhere on a piece to pin a note there · hold Shift to note the whole part'
                : 'Drag to orbit · scroll to zoom · click a piece to select it'}
          </p>
        </main>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-shell-800 bg-shell-950 p-3">
          {!doc ? (
            <PanelSkeleton rows={4} />
          ) : panel === 'render' ? (
            <RenderPanel
              renderMode={renderMode}
              onRenderModeChange={(next) => {
                setRenderMode(next);
                setSamples(0);
                setConverged(false);
              }}
              settings={renderSettings}
              onSettingsChange={setRenderSettings}
              samples={samples}
              converged={converged}
              renders={renders}
              onSaveRender={saveRender}
              onConceptRender={conceptRender}
              conceptAvailable={conceptAvailable}
              busy={busy}
            />
          ) : panel === 'history' ? (
            <VersionHistory sceneId={scene.id} onRestored={(restored) => markSaved(restored)} />
          ) : mode === 'comment' ? (
            <AnnotationPanel sceneId={scene.id} onChanged={refresh} />
          ) : (
            <Inspector />
          )}
        </aside>
      </div>

      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg border border-shell-700 bg-shell-900 p-4 shadow-xl">
            <h2 className="text-sm font-semibold text-shell-100">Someone else saved changes</h2>
            <p className="mt-2 text-xs leading-relaxed text-shell-400">
              This scene was saved again since you loaded it — it&rsquo;s now at version{' '}
              {conflict.current.version}, last saved{' '}
              {new Date(conflict.current.updatedAt).toLocaleString()}. Reload to see that version, or
              overwrite it with your changes. Nothing is lost either way — every save is kept in{' '}
              <span className="text-shell-100">History</span>.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="danger" onClick={overwriteAnyway}>
                Overwrite anyway
              </Button>
              <Button size="sm" variant="primary" onClick={() => void reloadFromServer()}>
                Reload
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Sample counts start fractional while the tracer warms up at low resolution.
 * Showing "0" then would read as broken, so keep a decimal until it clears 10.
 */
export function formatSamples(samples: number): string {
  return samples >= 10 ? String(Math.round(samples)) : samples.toFixed(1);
}

/** Placeholder shown for the one frame before the store is seeded. */
function PanelSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-lg border border-shell-800 bg-shell-900 p-3.5">
          <div className="mb-3 h-2 w-24 rounded bg-shell-800" />
          <div className="space-y-2">
            <div className="h-7 rounded bg-shell-850" />
            <div className="h-7 w-4/5 rounded bg-shell-850" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ExportMenu({
  onExport,
  disabled,
}: {
  onExport: (format: ExportFormat) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen((v) => !v)} disabled={disabled}>
        Export ▾
      </Button>
      {open && (
        <>
          {/* Click-away layer, so the menu closes without a document listener. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-shell-700 bg-shell-850 p-1 shadow-xl">
            {EXPORT_FORMATS.map((format) => (
              <button
                key={format.id}
                onClick={() => {
                  setOpen(false);
                  onExport(format.id);
                }}
                className="block w-full rounded-md px-2.5 py-2 text-left transition hover:bg-shell-800"
              >
                <span className="block text-sm text-shell-100">{format.label}</span>
                <span className="block text-[11px] leading-snug text-shell-400">{format.note}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Owner-facing read of the client's verdict from the share view - see `ClientApproval`. */
function ClientApprovalBadge({ status }: { status: ClientApproval }) {
  switch (status) {
    case 'approved':
      return <Badge tone="good">Client approved</Badge>;
    case 'approved_with_changes':
      return <Badge tone="warn">Client approved, with changes</Badge>;
    case 'changes_requested':
      return <Badge tone="bad">Client requested changes</Badge>;
    case 'not_relevant':
      return <Badge tone="neutral">Client: not relevant</Badge>;
    default:
      return null;
  }
}
