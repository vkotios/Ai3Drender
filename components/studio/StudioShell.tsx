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
import { useStudio, type LoadedVersion } from '@/lib/studio/store';
import type { Project, Scene } from '@/lib/types';

import { Inspector } from './Inspector';
import { Outliner } from './Outliner';
import type { GizmoMode } from './StudioCanvas';

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
}: {
  project: Project;
  scene: Scene;
  versions: LoadedVersion[];
  available: LoadedVersion[];
}) {
  const load = useStudio((s) => s.load);
  const doc = useStudio((s) => s.doc);
  const dirty = useStudio((s) => s.dirty);
  const markSaved = useStudio((s) => s.markSaved);

  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exportRoot = useRef<THREE.Group | null>(null);

  // Seeded in an effect rather than during render: the studio store is a
  // module singleton, and writing to it while server-rendering would leak one
  // request's scene into another's. The asides show a skeleton until it lands.
  useEffect(() => {
    // Seed the store with everything the scene references plus every finished
    // piece, so staging a new one needs no extra fetch.
    const seen = new Map(versions.map((v) => [v.version.id, v]));
    for (const v of available) if (!seen.has(v.version.id)) seen.set(v.version.id, v);
    load(scene, [...seen.values()]);
  }, [load, scene, versions, available]);

  const onExportRootReady = useCallback((root: THREE.Group | null) => {
    exportRoot.current = root;
  }, []);

  const save = useCallback(async () => {
    const current = useStudio.getState().doc;
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/scenes/${scene.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: current, note: 'edited in studio' }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Save failed');
      markSaved(await response.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [scene.id, markSaved]);

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
        {dirty && <Badge tone="warn">Unsaved</Badge>}
        {busy && <Badge tone="busy">{busy}…</Badge>}
        {error && (
          <span className="truncate text-xs text-red-400" title={error}>
            {error}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <div className="mr-1 flex rounded-md border border-shell-700 p-0.5">
            {(['translate', 'rotate', 'scale'] as GizmoMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setGizmoMode(mode)}
                className={`rounded px-2 py-1 text-[11px] capitalize transition ${
                  gizmoMode === mode
                    ? 'bg-shell-700 text-shell-100'
                    : 'text-shell-400 hover:text-shell-100'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>

          <Button size="sm" onClick={artDirect} disabled={Boolean(busy)}>
            Art-direct
          </Button>

          <ExportMenu onExport={handleExport} disabled={Boolean(busy)} />

          <Button size="sm" variant="primary" onClick={save} disabled={saving || !dirty}>
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
            <StudioCanvas doc={doc} gizmoMode={gizmoMode} onExportRootReady={onExportRootReady} />
          )}
          <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-shell-950/80 px-3 py-1 text-[11px] text-shell-400">
            Drag to orbit · scroll to zoom · click a piece to select it
          </p>
        </main>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-shell-800 bg-shell-950 p-3">
          {doc ? <Inspector /> : <PanelSkeleton rows={4} />}
        </aside>
      </div>
    </div>
  );
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
