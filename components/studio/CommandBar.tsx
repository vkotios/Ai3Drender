'use client';

import { useState } from 'react';

import { Button, TextInput } from '@/components/ui';
import { useStudio } from '@/lib/studio/store';
import type { Scene } from '@/lib/types';

interface CommandResponse {
  scene: Scene;
  summary: string;
  unresolved: string[];
}

type Feedback = { tone: 'ok' | 'warn' | 'error'; text: string };

/**
 * Natural-language studio command box (issue #60): "move the sofa 30cm left
 * and warm up the lighting" as a typed command instead of manual gizmo work.
 *
 * POSTs to `POST /api/scenes/:sceneId/command`, which interprets the command
 * into a small, closed set of scene mutations (see lib/scene/command.ts and
 * its PR description for the full list and why it stops there), applies
 * them, and saves through the ordinary scene-save path - so a successful
 * response IS the new saved scene, exactly like a manual Save, and
 * `markSaved` is all the local state update this needs.
 *
 * Deliberately blocked while there are unsaved manual edits: the server
 * computes mutations against its own stored `doc`, not whatever is only
 * staged locally, so running a command over unsaved edits would silently
 * discard them the moment the response overwrites local state.
 */
export function CommandBar({ sceneId }: { sceneId: string }) {
  const dirty = useStudio((s) => s.dirty);
  const markSaved = useStudio((s) => s.markSaved);
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const run = async () => {
    const trimmed = command.trim();
    if (!trimmed || busy) return;
    const scene = useStudio.getState().scene;
    if (!scene) return;

    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/scenes/${sceneId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: trimmed, expectedVersion: scene.version }),
      });
      const body = await response.json().catch(() => ({}));

      if (response.status === 409) {
        setFeedback({
          tone: 'error',
          text: 'Someone else saved changes to this scene since you loaded it - reload the studio, then try the command again.',
        });
        return;
      }
      if (!response.ok) {
        setFeedback({ tone: 'error', text: body.error ?? 'That command could not be run.' });
        return;
      }

      const result = body as CommandResponse;
      markSaved(result.scene);
      setCommand('');
      setFeedback(
        result.unresolved.length > 0
          ? { tone: 'warn', text: `${result.summary} Could not apply: ${result.unresolved.join(' ')}` }
          : { tone: 'ok', text: result.summary },
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
              ? 'Save or discard your changes before running a command'
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
