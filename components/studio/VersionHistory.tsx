'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Empty, Panel } from '@/components/ui';
import { useStudio } from '@/lib/studio/store';
import type { Scene, SceneVersion } from '@/lib/types';

/**
 * Read-and-recover view over `scene_versions` (or `LocalStore`'s in-memory
 * equivalent): every past save of this scene's `doc`, retained even after a
 * clobbered write, with a way to bring one back.
 */
export function VersionHistory({
  sceneId,
  onRestored,
}: {
  sceneId: string;
  onRestored: (scene: Scene) => void;
}) {
  const currentVersion = useStudio((s) => s.scene?.version);

  const [versions, setVersions] = useState<SceneVersion[] | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/scenes/${sceneId}/versions`);
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not load history');
      setVersions(await response.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load history');
    }
  }, [sceneId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(versionNumber: number) {
    setRestoring(versionNumber);
    setError(null);
    try {
      const response = await fetch(`/api/scenes/${sceneId}/versions/${versionNumber}`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not restore');
      const restored: Scene = await response.json();
      onRestored(restored);
      // The restore itself is now the latest save, so refresh the list to
      // show it (and its new version number) rather than the stale one.
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restore');
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {versions === null ? (
        <Panel title="History">
          <p className="text-xs text-shell-400">Loading…</p>
        </Panel>
      ) : versions.length === 0 ? (
        <Empty title="No saves yet">Every save of this scene will show up here.</Empty>
      ) : (
        <Panel title="Version history">
          <ol className="space-y-2">
            {versions.map((version) => {
              const isCurrent = version.versionNumber === currentVersion;
              return (
                <li
                  key={version.id}
                  className={`rounded-md border p-2 ${
                    isCurrent ? 'border-amber-600 bg-shell-800' : 'border-shell-800'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-xs text-shell-100">
                        Version {version.versionNumber}
                        {isCurrent && <Badge tone="good">current</Badge>}
                      </p>
                      <p className="mt-0.5 text-[11px] text-shell-400">
                        {new Date(version.createdAt).toLocaleString()}
                      </p>
                      {version.note && (
                        <p className="mt-0.5 truncate text-[11px] text-shell-500" title={version.note}>
                          {version.note}
                        </p>
                      )}
                    </div>
                    {!isCurrent && (
                      <Button
                        size="sm"
                        disabled={restoring !== null}
                        onClick={() => restore(version.versionNumber)}
                      >
                        {restoring === version.versionNumber ? 'Restoring…' : 'Restore'}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </Panel>
      )}
    </div>
  );
}
