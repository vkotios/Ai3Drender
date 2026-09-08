'use client';

import { useState } from 'react';

import { Button, TextInput } from '@/components/ui';
import { applySceneMutations, type SceneMutation } from '@/lib/scene/command';
import { useStudio } from '@/lib/studio/store';

interface InterpretResponse {
  mutations: SceneMutation[];
  unresolved: string[];
}

type Feedback = { tone: 'ok' | 'warn' | 'error'; text: string };

/**
 * Natural-language studio command box (issue #60): "move the sofa 30cm left
 * and warm up the lighting" as a typed command instead of manual gizmo work.
 *
 * Issue #89 split this into two steps rather than one interpret-apply-save
 * round trip: `POST .../command/interpret` only turns the free text into a
 * validated `SceneMutation[]` (a Gemini call, or the offline parser - see
 * lib/scene/command.ts for why the mutation set stays closed). Applying them
 * happens right here, via the same pure `applySceneMutations` the old combined
 * route used to call server-side, straight onto the in-memory `doc` - so the
 * result lands in the viewport instantly, before any save round trip, exactly
 * like a manual drag would. `setDoc` marks the scene dirty the same way any
 * other studio edit does, so committing is just the ordinary Save button
 * (with its usual conflict handling), and discarding is the same "reload the
 * stand" every other unsaved edit in the studio already relies on - see the
 * Inspector's version-compare panel for that same convention.
 *
 * Issue #90: the node the command's last mutation touched is selected
 * afterward, so the Inspector's numeric fields pick up the result immediately
 * for hand-tuning, the same fields a manual gizmo drag would leave populated.
 *
 * Still blocked while there are unsaved manual edits: the interpreter reads
 * the server's own persisted `doc`, not whatever is only staged locally, so
 * running a command over unsaved edits could resolve node names or "current"
 * values against a doc your local edits have already diverged from.
 */
export function CommandBar({ sceneId }: { sceneId: string }) {
  const dirty = useStudio((s) => s.dirty);
  const setDoc = useStudio((s) => s.setDoc);
  const select = useStudio((s) => s.select);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const run = async () => {
    const trimmed = command.trim();
    if (!trimmed || busy) return;
    const state = useStudio.getState();
    if (!state.doc) return;

    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/scenes/${sceneId}/command/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: trimmed }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFeedback({ tone: 'error', text: body.error ?? 'That command could not be interpreted.' });
        return;
      }

      const { mutations, unresolved } = body as InterpretResponse;
      const applied = applySceneMutations(state.doc, mutations, state.versions);
      const notes = [...unresolved, ...applied.problems];
      setCommand('');

      if (applied.changes.length === 0) {
        setFeedback({
          tone: notes.length > 0 ? 'warn' : 'ok',
          text:
            notes.length > 0
              ? `Nothing in that command could be applied. ${notes.join(' ')}`
              : 'Nothing in that command could be applied.',
        });
        return;
      }

      setDoc(applied.doc);
      if (applied.lastTouchedNodeId) select(applied.lastTouchedNodeId);
      setFeedback(
        notes.length > 0
          ? { tone: 'warn', text: `${applied.changes.join(' ')} Could not apply: ${notes.join(' ')}` }
          : { tone: 'ok', text: `${applied.changes.join(' ')} Not saved yet - review, then Save.` },
      );
    } catch (cause) {
      setFeedback({ tone: 'error', text: cause instanceof Error ? cause.message : 'That command could not be run.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-shell-800 bg-shell-900 px-4 py-2">
      <div className="flex items-center gap-2">
        <TextInput
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
          placeholder={
            dirty
              ? 'Save or reload to discard your changes before running a command'
              : 'Tell the studio what to change - e.g. "move the sofa 30cm left and warm up the lighting"'
          }
          disabled={dirty || busy}
          className="flex-1"
        />
        <Button size="sm" onClick={() => void run()} disabled={dirty || busy || !command.trim()}>
          {busy ? 'Running…' : 'Run'}
        </Button>
      </div>
      {feedback && (
        <p
          className={
            feedback.tone === 'error'
              ? 'text-[11px] text-red-400'
              : feedback.tone === 'warn'
                ? 'text-[11px] text-amber-400'
                : 'text-[11px] text-emerald-400'
          }
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
}
