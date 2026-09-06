'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Empty, Panel } from '@/components/ui';
import { useStudio, type LoadedVersion } from '@/lib/studio/store';
import type { Scene, SceneVersion } from '@/lib/types';

import { SplitCompareOverlay, type ComparePane } from './CompareViewport';

interface ResolvedSceneVersion {
  sceneVersion: SceneVersion;
  versions: LoadedVersion[];
}

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

  // Up to two version numbers picked for the side-by-side compare below.
  const [picked, setPicked] = useState<number[]>([]);
  const [comparing, setComparing] = useState(false);
  const [comparePanes, setComparePanes] = useState<[ComparePane, ComparePane] | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

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

  function togglePick(versionNumber: number) {
    setPicked((current) => {
      if (current.includes(versionNumber)) return current.filter((n) => n !== versionNumber);
      // At most two - picking a third drops the oldest pick rather than
      // refusing the click, so re-picking never needs an extra un-check first.
      return current.length < 2 ? [...current, versionNumber] : [current[1], versionNumber];
    });
  }

  async function openCompare() {
    if (picked.length !== 2) return;
    setComparing(true);
    setCompareError(null);
    try {
      const [left, right] = await Promise.all(
        picked.map((versionNumber) => resolveSceneVersion(sceneId, versionNumber)),
      );
      setComparePanes([toComparePane(left), toComparePane(right)]);
    } catch (cause) {
      setCompareError(cause instanceof Error ? cause.message : 'Could not load those versions');
    } finally {
      setComparing(false);
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
        <Panel
          title="Version history"
          actions={
            versions.length >= 2 ? (
              <Button size="sm" disabled={picked.length !== 2 || comparing} onClick={openCompare}>
                {comparing ? 'Loading…' : `Compare${picked.length === 2 ? '' : ` (${picked.length}/2)`}`}
              </Button>
            ) : undefined
          }
        >
          {compareError && (
            <p className="mb-2 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-300">
              {compareError}
            </p>
          )}
          {versions.length >= 2 && (
            <p className="mb-2 text-[11px] leading-snug text-shell-400">
              Check any two saves to view them side by side, camera-synced.
            </p>
          )}
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
                    <label className="flex min-w-0 items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-shell-100"
                        checked={picked.includes(version.versionNumber)}
                        onChange={() => togglePick(version.versionNumber)}
                        aria-label={`Select version ${version.versionNumber} to compare`}
                      />
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
                    </label>
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

      {comparePanes && (
        <SplitCompareOverlay
          title="Comparing scene saves"
          left={comparePanes[0]}
          right={comparePanes[1]}
          onClose={() => setComparePanes(null)}
        />
      )}
    </div>
  );
}

/** The resolved doc plus mesh URLs for one past save - see the `resolve` route. */
async function resolveSceneVersion(sceneId: string, versionNumber: number): Promise<ResolvedSceneVersion> {
  const response = await fetch(`/api/scenes/${sceneId}/versions/${versionNumber}/resolve`);
  if (!response.ok) throw new Error((await response.json()).error ?? 'Could not load version');
  return response.json();
}

function toComparePane({ sceneVersion, versions }: ResolvedSceneVersion): ComparePane {
  return {
    label: `Version ${sceneVersion.versionNumber}`,
    sublabel: new Date(sceneVersion.createdAt).toLocaleString(),
    doc: sceneVersion.doc,
    versions: Object.fromEntries(versions.map((v) => [v.version.id, v])),
  };
}
