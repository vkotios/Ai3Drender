'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import { Badge, Button, Empty, Field, Panel, TextInput } from '@/components/ui';
import { useStudio, type LoadedVersion } from '@/lib/studio/store';
import type { Annotation, ClientApproval, Scene, ShareRole } from '@/lib/types';

// Same client-only constraint as the authenticated studio - WebGL and drei's
// HDRI loading do not exist on the server.
const StudioCanvas = dynamic(() => import('./StudioCanvas').then((m) => m.StudioCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-shell-400">
      Starting the viewport…
    </div>
  ),
});

// The AR viewer wraps a web component (see ArViewer.tsx) that touches
// `customElements`/`document` on load - same client-only constraint as the
// canvas above.
const ArViewer = dynamic(() => import('./ArViewer').then((m) => m.ArViewer), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-shell-400">
      Loading AR viewer…
    </div>
  ),
});

const CLIENT_NAME_KEY = 'ai3drender:share-client-name';

/** Every verdict the client can actively submit - `pending` is a state, not a choice. */
const REVIEW_CHOICES: { value: Exclude<ClientApproval, 'pending'>; label: string; hint: string }[] = [
  { value: 'approved', label: 'Approved', hint: 'Nothing to change - ready to build.' },
  {
    value: 'approved_with_changes',
    label: 'Approved, with changes',
    hint: 'Sign off now; the notes below cover what still needs adjusting.',
  },
  {
    value: 'changes_requested',
    label: 'Changes requested',
    hint: 'Please address the notes before this goes ahead.',
  },
  { value: 'not_relevant', label: 'Not relevant to me', hint: "This stand isn't mine to review." },
];

function approvalLabel(status: ClientApproval): string {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'approved_with_changes':
      return 'Approved, with changes';
    case 'changes_requested':
      return 'Changes requested';
    case 'not_relevant':
      return 'Marked not relevant';
    default:
      return 'Pending';
  }
}

/**
 * The client's read-only review view.
 *
 * This is a deliberately smaller shell than StudioShell, not a feature-flagged
 * version of it: there is no gizmo toolbar, no Outliner, no Save, no Export.
 * `role` decides the rest of the surface area:
 *
 * - 'commenter' pins studio mode to 'comment' for the lifetime of the page -
 *   orbit and inspect, plus the same anchored-note machinery the internal
 *   review loop uses, and the sign-off controls.
 * - 'viewer' pins mode to 'view' instead, and this component renders none of
 *   the note-pinning or approve/request-changes UI at all - not hidden behind
 *   a disabled state, just never in the tree. Orbit/inspect is the entire
 *   surface area for that tier.
 *
 * Either way, nothing here can stage a piece or read back an edited
 * transform, because nothing here offers a way to make one - and for a
 * 'viewer' link, the write API routes themselves (app/api/share/[token]/
 * annotations and .../review) reject the request server-side regardless of
 * what this component renders; the UI split below is not the security
 * boundary.
 */
export function ShareStudioShell({
  token,
  scene,
  versions,
  annotations,
  role,
}: {
  token: string;
  scene: Scene;
  versions: LoadedVersion[];
  annotations: Annotation[];
  role: ShareRole;
}) {
  const canComment = role === 'commenter';

  const load = useStudio((s) => s.load);
  const setMode = useStudio((s) => s.setMode);
  const doc = useStudio((s) => s.doc);
  const storeAnnotations = useStudio((s) => s.annotations);
  const setAnnotations = useStudio((s) => s.setAnnotations);
  const pendingPin = useStudio((s) => s.pendingPin);
  const setPendingPin = useStudio((s) => s.setPendingPin);

  const [clientName, setClientName] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<ClientApproval>(scene.clientApproval);
  const [approvalMeta, setApprovalMeta] = useState({
    at: scene.clientApprovalAt,
    name: scene.clientApprovalName,
    note: scene.clientApprovalNote,
  });
  const [reviewNote, setReviewNote] = useState('');
  const [arVersionId, setArVersionId] = useState<string | null>(null);
  const [reviewChoice, setReviewChoice] = useState<Exclude<ClientApproval, 'pending'>>(
    scene.clientApproval === 'pending' ? 'approved' : scene.clientApproval,
  );

  useEffect(() => {
    load(scene, versions, annotations);
    // Pinned for the whole session: this view never offers a way back to
    // 'layout' mode, which is what keeps the gizmo and staging tools out.
    // A 'viewer' link never enters 'comment' mode at all, so AssetNode's
    // click handler falls through to a plain (harmless, unrendered) select
    // instead of pinning - see lib/studio/store.ts's StudioMode doc.
    setMode(canComment ? 'comment' : 'view');
  }, [load, setMode, scene, versions, annotations, canComment]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CLIENT_NAME_KEY);
      if (saved) setClientName(saved);
    } catch {
      // Private browsing or storage blocked - just start with a blank field.
    }
  }, []);

  const rememberName = (name: string) => {
    setClientName(name);
    try {
      window.localStorage.setItem(CLIENT_NAME_KEY, name);
    } catch {
      // Fine to lose across reloads.
    }
  };

  const pieceName = (assetId: string) =>
    Object.values(useStudio.getState().versions).find((v) => v.version.assetId === assetId)
      ?.version.spec.displayName ?? 'this piece';

  async function savePin() {
    if (!pendingPin || !draft.trim() || !clientName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/share/${token}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName,
          body: draft,
          point: pendingPin.point,
          normal: pendingPin.normal,
          partName: pendingPin.partName,
          assetVersionId: pendingPin.assetVersionId,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not save the note');
      const saved: Annotation = await response.json();
      setAnnotations([...useStudio.getState().annotations, saved]);
      setDraft('');
      setPendingPin(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the note');
    } finally {
      setBusy(false);
    }
  }

  async function submitReview(status: ClientApproval) {
    if (!clientName.trim()) {
      setError('Enter your name first');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/share/${token}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reviewerName: clientName, note: reviewNote }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not save your review');
      const updated: Scene = await response.json();
      setApproval(updated.clientApproval);
      setApprovalMeta({
        at: updated.clientApprovalAt,
        name: updated.clientApprovalName,
        note: updated.clientApprovalNote,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your review');
    } finally {
      setBusy(false);
    }
  }

  const byAsset = new Map<string, Annotation[]>();
  for (const annotation of storeAnnotations) {
    if (annotation.status === 'dismissed') continue;
    // Threaded replies (studio-only for now) nest under their parent rather
    // than showing here as their own note - see Annotation.parentAnnotationId.
    if (annotation.parentAnnotationId) continue;
    byAsset.set(annotation.assetId, [...(byAsset.get(annotation.assetId) ?? []), annotation]);
  }

  const arVersion = versions.find((v) => v.version.id === arVersionId)?.version ?? null;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-shell-800 bg-shell-900 px-4 py-2.5">
        <Badge tone="neutral">{canComment ? 'Client review' : 'View only'}</Badge>
        <h1 className="truncate text-sm font-medium text-shell-100">{scene.name}</h1>
        {canComment && <ApprovalBadge status={approval} />}
        {canComment && error && (
          <span className="ml-auto truncate text-xs text-red-400" title={error}>
            {error}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 bg-shell-900">
          {doc && (
            <StudioCanvas
              doc={doc}
              gizmoMode="translate"
              renderMode="preview"
              renderSettings={{ bounces: 3, maxSamples: 1, resolutionScale: 1 }}
              onSamples={() => {}}
              onExportRootReady={() => {}}
              onCanvasReady={() => {}}
            />
          )}
          <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-shell-950/80 px-3 py-1 text-[11px] text-shell-400">
            {canComment ? 'Drag to orbit · scroll to zoom · click a piece to leave a note' : 'Drag to orbit · scroll to zoom'}
          </p>
        </main>

        {canComment && (
        <aside className="w-80 shrink-0 space-y-3 overflow-y-auto border-l border-shell-800 bg-shell-950 p-3">
          <Panel title="Your name">
            <TextInput
              value={clientName}
              onChange={(e) => rememberName(e.target.value)}
              placeholder="Jane, Acme Corp"
            />
            <p className="mt-1.5 text-[11px] text-shell-400">
              Shown on every note and on your sign-off, so the workshop knows who to ask.
            </p>
          </Panel>

          <Panel title="View in AR">
            {versions.length === 0 ? (
              <p className="text-xs leading-relaxed text-shell-400">
                No AR-ready pieces in this stand yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {versions.map(({ version }) => (
                  <li key={version.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-shell-200">
                      {version.spec.displayName}
                    </span>
                    <Button size="sm" onClick={() => setArVersionId(version.id)}>
                      View in AR
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-shell-400">
              Opens on your phone with an AR button - point your camera at the floor to place it at
              actual size. Needs Chrome on Android (WebXR/Scene Viewer); iOS support is limited to
              orbiting the model for now.
            </p>
          </Panel>

          {pendingPin ? (
            <Panel title="New note">
              <p className="mb-2 text-[11px] text-shell-400">
                Pinned to <span className="text-shell-100">{pendingPin.partName ?? 'this surface'}</span> on{' '}
                {pieceName(pendingPin.assetId)}.
              </p>
              <TextInput
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && savePin()}
                placeholder="This leg looks too thick"
              />
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={savePin}
                  disabled={busy || !draft.trim() || !clientName.trim()}
                >
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
              {!clientName.trim() && (
                <p className="mt-1.5 text-[11px] text-amber-400">Enter your name above first.</p>
              )}
            </Panel>
          ) : (
            <Panel title="Leave feedback">
              <p className="text-xs leading-relaxed text-shell-400">
                Click anywhere on a piece in the viewport to pin a note there.
              </p>
            </Panel>
          )}

          {byAsset.size === 0 ? (
            <Empty title="No notes yet">Click a piece to leave the first one.</Empty>
          ) : (
            [...byAsset.entries()].map(([assetId, list]) => (
              <Panel key={assetId} title={pieceName(assetId)}>
                <ol className="space-y-2">
                  {list.map((annotation, index) => (
                    <li key={annotation.id} className="rounded-md border border-shell-800 p-2">
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-shell-950">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs leading-snug text-shell-100">{annotation.body}</p>
                          <p className="mt-0.5 text-[11px] text-shell-400">
                            {annotation.componentName ?? annotation.partName ?? 'surface'} ·{' '}
                            {annotation.anchorDescription}
                          </p>
                          <div className="mt-1">
                            {annotation.source === 'client' ? (
                              <Badge tone="warn">Client · {annotation.clientName}</Badge>
                            ) : (
                              <Badge tone="neutral">Internal</Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </Panel>
            ))
          )}

          <Panel title="Sign off">
            {approval !== 'pending' && (
              <p className="mb-2 text-[11px] leading-relaxed text-shell-400">
                {approvalLabel(approval)} by {approvalMeta.name}
                {approvalMeta.at && ` on ${new Date(approvalMeta.at).toLocaleString()}`}
                {approvalMeta.note && <> — &quot;{approvalMeta.note}&quot;</>}
              </p>
            )}
            <fieldset className="space-y-1.5">
              <legend className="sr-only">Review verdict</legend>
              {REVIEW_CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-shell-800 p-2 has-[:checked]:border-shell-500 has-[:checked]:bg-shell-900"
                >
                  <input
                    type="radio"
                    name="review-verdict"
                    value={choice.value}
                    checked={reviewChoice === choice.value}
                    onChange={() => setReviewChoice(choice.value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-xs text-shell-100">{choice.label}</span>
                    <span className="block text-[11px] text-shell-400">{choice.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="mt-2">
              <Field label="Notes (optional)">
                <TextInput
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  placeholder="Looks great, just fix the notes above"
                />
              </Field>
            </div>
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !clientName.trim()}
                onClick={() => submitReview(reviewChoice)}
              >
                Submit review
              </Button>
            </div>
          </Panel>
        </aside>
        )}
      </div>

      {arVersion && (
        <div className="fixed inset-0 z-50 flex flex-col bg-shell-950">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-shell-800 px-4 py-2.5">
            <h2 className="truncate text-sm font-medium text-shell-100">
              {arVersion.spec.displayName} · AR view
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setArVersionId(null)}>
              Close
            </Button>
          </header>
          <div className="min-h-0 flex-1">
            <ArViewer
              src={`/api/share/${token}/ar/${arVersion.id}`}
              alt={arVersion.spec.displayName}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalBadge({ status }: { status: ClientApproval }) {
  switch (status) {
    case 'approved':
      return <Badge tone="good">Approved</Badge>;
    case 'approved_with_changes':
      return <Badge tone="warn">Approved, with changes</Badge>;
    case 'changes_requested':
      return <Badge tone="bad">Changes requested</Badge>;
    case 'not_relevant':
      return <Badge tone="neutral">Not relevant</Badge>;
    default:
      return <Badge tone="neutral">Awaiting review</Badge>;
  }
}
