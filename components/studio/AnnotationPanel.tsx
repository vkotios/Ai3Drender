'use client';

import { useState } from 'react';

import { Badge, Button, Empty, Panel, TextInput } from '@/components/ui';
import { useStudio } from '@/lib/studio/store';
import type { Annotation, SelectionKind } from '@/lib/types';

/**
 * The review loop: pin a note to a spot on a piece, then hand the open notes
 * to the model as one revision round.
 *
 * Notes are grouped by piece because a revision round is per-piece - each one
 * produces a new version of that piece and nothing else.
 */
export function AnnotationPanel({ sceneId, onChanged }: { sceneId: string; onChanged: () => void }) {
  const mode = useStudio((s) => s.mode);
  const selectionMode = useStudio((s) => s.selectionMode);
  const setSelectionMode = useStudio((s) => s.setSelectionMode);
  const annotations = useStudio((s) => s.annotations);
  const versions = useStudio((s) => s.versions);
  const pendingPin = useStudio((s) => s.pendingPin);
  const setPendingPin = useStudio((s) => s.setPendingPin);
  const setAnnotations = useStudio((s) => s.setAnnotations);
  const selectedAnnotationId = useStudio((s) => s.selectedAnnotationId);
  const selectAnnotation = useStudio((s) => s.selectAnnotation);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Name of the piece an annotation belongs to, for grouping. */
  const pieceName = (assetId: string) =>
    Object.values(versions).find((v) => v.version.assetId === assetId)?.version.spec.displayName ??
    'Unknown piece';

  const byAsset = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    if (annotation.status === 'dismissed') continue;
    byAsset.set(annotation.assetId, [...(byAsset.get(annotation.assetId) ?? []), annotation]);
  }

  async function savePin() {
    if (!pendingPin || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${pendingPin.assetId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: draft,
          point: pendingPin.point,
          normal: pendingPin.normal,
          partName: pendingPin.partName,
          selectionKind: pendingPin.selectionKind,
          instanceCount: pendingPin.instanceCount,
          assetVersionId: pendingPin.assetVersionId,
          sceneId,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not save the note');
      const saved: Annotation = await response.json();
      setAnnotations([...annotations, saved]);
      setDraft('');
      setPendingPin(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the note');
    } finally {
      setBusy(false);
    }
  }

  async function remove(annotation: Annotation) {
    await fetch(`/api/annotations/${annotation.id}`, { method: 'DELETE' });
    setAnnotations(annotations.filter((a) => a.id !== annotation.id));
  }

  /** Send every open note on one piece to the model as a single revision. */
  async function applyNotes(assetId: string, rebuildMesh: boolean) {
    const open = (byAsset.get(assetId) ?? []).filter((a) => a.status === 'open');
    if (open.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/assets/${assetId}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: '',
          annotationIds: open.map((a) => a.id),
          rebuildMesh,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not queue the revision');
      await fetch('/api/jobs/tick', { method: 'POST' });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue the revision');
    } finally {
      setBusy(false);
    }
  }

  if (mode !== 'comment') {
    return (
      <Panel title="Review">
        <p className="text-xs leading-relaxed text-shell-400">
          Switch to <span className="text-shell-100">Comment</span> mode to pin notes to specific
          points on a piece and send them to the model as a revision.
        </p>
        {annotations.filter((a) => a.status === 'open').length > 0 && (
          <p className="mt-2 text-xs text-amber-300">
            {annotations.filter((a) => a.status === 'open').length} note(s) still open.
          </p>
        )}
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      {pendingPin ? (
        <Panel title="New note">
          <p className="mb-2 text-[11px] text-shell-400">
            {pendingPin.selectionKind === 'part' ? (
              <>
                Selected the whole{' '}
                <span className="text-shell-100">{pendingPin.partName ?? 'part'}</span>
                {pendingPin.instanceCount > 1 ? ` (all ${pendingPin.instanceCount} instances)` : ''}{' '}
                on {pieceName(pendingPin.assetId)}.
              </>
            ) : (
              <>
                Pinned to{' '}
                <span className="text-shell-100">{pendingPin.partName ?? 'this surface'}</span> on{' '}
                {pieceName(pendingPin.assetId)}.
              </>
            )}
          </p>
          <TextInput
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && savePin()}
            placeholder={
              pendingPin.selectionKind === 'part'
                ? 'Slim all of these down to 40mm square'
                : 'Slim this leg to 40mm square'
            }
          />
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant="primary" onClick={savePin} disabled={busy || !draft.trim()}>
              Pin note
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPendingPin(null);
                setDraft('');
              }}
            >
              Cancel
            </Button>
          </div>
        </Panel>
      ) : (
        <Panel title="Comment mode">
          <p className="mb-2.5 text-xs leading-relaxed text-shell-400">
            Click a piece to pin a note there. A note records which part it landed on and where,
            so the model knows exactly what you mean.
          </p>
          <p className="mb-1.5 text-[11px] font-medium text-shell-300">Clicking selects</p>
          <div className="flex rounded-md border border-shell-700 p-0.5">
            {(
              [
                { value: 'point', label: 'This point' },
                { value: 'part', label: 'Whole part' },
              ] as { value: SelectionKind; label: string }[]
            ).map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setSelectionMode(value)}
                className={`flex-1 rounded px-2 py-1 text-[11px] transition ${
                  selectionMode === value
                    ? 'bg-shell-700 text-shell-100'
                    : 'text-shell-400 hover:text-shell-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-shell-500">
            Hold <span className="text-shell-300">Shift</span> while clicking to use the other one
            just this once.
          </p>
        </Panel>
      )}

      {error && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {byAsset.size === 0 ? (
        <Empty title="No notes yet">Click a piece in the viewport to leave the first one.</Empty>
      ) : (
        [...byAsset.entries()].map(([assetId, list]) => {
          const open = list.filter((a) => a.status === 'open');
          return (
            <Panel
              key={assetId}
              title={pieceName(assetId)}
              actions={<Badge tone={open.length ? 'warn' : 'good'}>{open.length} open</Badge>}
            >
              <ol className="space-y-2">
                {list.map((annotation, index) => (
                  <li
                    key={annotation.id}
                    onClick={() => selectAnnotation(annotation.id)}
                    className={`cursor-pointer rounded-md border p-2 transition ${
                      annotation.id === selectedAnnotationId
                        ? 'border-amber-600 bg-shell-800'
                        : 'border-shell-800 hover:border-shell-600'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                          annotation.status === 'applied'
                            ? 'bg-emerald-600 text-shell-950'
                            : 'bg-amber-500 text-shell-950'
                        }`}
                      >
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs leading-snug text-shell-100">{annotation.body}</p>
                        <p className="mt-0.5 text-[11px] text-shell-400">
                          {annotation.componentName ?? annotation.partName ?? 'surface'} ·{' '}
                          {annotation.anchorDescription}
                          {annotation.selectionKind === 'part' && (
                            <>
                              {' '}
                              <Badge tone="neutral">Part</Badge>
                            </>
                          )}
                        </p>
                        {annotation.status === 'applied' && (
                          <p className="mt-0.5 text-[11px] text-emerald-400">
                            Applied in a newer version
                          </p>
                        )}
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(annotation);
                        }}
                        className="shrink-0 text-[11px] text-shell-500 hover:text-red-400"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ol>

              {open.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-shell-800 pt-3">
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => applyNotes(assetId, false)}>
                    Apply {open.length} note{open.length === 1 ? '' : 's'}
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => applyNotes(assetId, true)}>
                    Apply &amp; rebuild mesh
                  </Button>
                </div>
              )}
            </Panel>
          );
        })
      )}
    </div>
  );
}
