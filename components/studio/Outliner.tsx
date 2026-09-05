'use client';

import { Badge, Button, Empty, Panel } from '@/components/ui';
import { autoArrange, createAssetNode, createPropNode, nextPlacement } from '@/lib/scene/defaults';
import { PROP_DEFINITIONS, getPreset } from '@/lib/scene/presets';
import { useStudio, type LoadedVersion } from '@/lib/studio/store';
import type { PropKind } from '@/lib/types';

/** Left-hand panel: what is on the stand, and how to put more there. */
export function Outliner({ available }: { available: LoadedVersion[] }) {
  const doc = useStudio((s) => s.doc);
  const selectedId = useStudio((s) => s.selectedId);
  const select = useStudio((s) => s.select);
  const addNode = useStudio((s) => s.addNode);
  const patchNode = useStudio((s) => s.patchNode);
  const setDoc = useStudio((s) => s.setDoc);
  const registerVersion = useStudio((s) => s.registerVersion);
  const versions = useStudio((s) => s.versions);

  if (!doc) return null;

  /** Real-world width of a staged node, in metres, for layout maths. */
  const footprintOf = (node: (typeof doc.nodes)[number]) => {
    const staged = node.assetVersionId ? versions[node.assetVersionId] : null;
    const width = staged ? staged.version.spec.dimensions.widthMm / 1000 : 1;
    return width * node.transform.scale.x;
  };

  const staged = new Set(doc.nodes.map((n) => n.assetVersionId).filter(Boolean));
  const unstaged = available.filter((v) => !staged.has(v.version.id));
  const suggestedProps = getPreset(doc.environment.presetId).suggestedProps;

  return (
    <div className="space-y-3">
      <Panel
        title={`On the stand (${doc.nodes.length})`}
        actions={
          doc.nodes.some((n) => n.kind === 'asset') ? (
            <button
              onClick={() =>
                setDoc({
                  ...doc,
                  nodes: autoArrange(
                    doc.nodes,
                    new Map(doc.nodes.map((n) => [n.id, footprintOf(n)])),
                    doc.environment.boothWidth,
                  ),
                })
              }
              className="text-[11px] text-shell-400 transition hover:text-shell-100"
            >
              Arrange
            </button>
          ) : null
        }
      >
        {doc.nodes.length === 0 ? (
          <Empty title="Nothing staged yet">
            Add a finished piece below to start laying out the booth.
          </Empty>
        ) : (
          <ul className="space-y-1">
            {doc.nodes.map((node) => (
              <li key={node.id}>
                <div
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition ${
                    node.id === selectedId
                      ? 'bg-shell-700 text-shell-100'
                      : 'text-shell-300 hover:bg-shell-800'
                  }`}
                >
                  <button
                    onClick={() => select(node.id)}
                    className="flex-1 truncate text-left"
                    title={node.name}
                  >
                    {node.name}
                  </button>
                  <button
                    onClick={() => patchNode(node.id, { visible: !node.visible })}
                    title={node.visible ? 'Hide' : 'Show'}
                    className="text-[11px] text-shell-400 hover:text-shell-100"
                  >
                    {node.visible ? 'shown' : 'hidden'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Add a piece">
        {unstaged.length === 0 ? (
          <p className="text-xs text-shell-400">
            {available.length === 0
              ? 'No finished pieces yet. Reconstruct one from photographs first.'
              : 'Every finished piece is already on the stand.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {unstaged.map(({ version }) => (
              <li key={version.id}>
                <button
                  onClick={() => {
                    registerVersion(available.find((v) => v.version.id === version.id)!);
                    // Place beside what is already staged rather than inside it.
                    const position = nextPlacement(
                      doc,
                      footprintOf,
                      version.spec.dimensions.widthMm / 1000,
                    );
                    addNode(
                      createAssetNode(version, version.spec.displayName, { position }),
                    );
                  }}
                  className="w-full rounded-md border border-shell-800 px-2.5 py-2 text-left transition hover:border-shell-600 hover:bg-shell-800"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-shell-100">
                      {version.spec.displayName}
                    </span>
                    <Badge tone={version.acceptedAt ? 'good' : 'neutral'}>
                      v{version.versionNumber}
                    </Badge>
                  </div>
                  <span className="mt-0.5 block text-[11px] text-shell-400">
                    {version.spec.dimensions.widthMm} × {version.spec.dimensions.depthMm} ×{' '}
                    {version.spec.dimensions.heightMm} mm
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Staging props">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(PROP_DEFINITIONS) as PropKind[]).map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={suggestedProps.includes(kind) ? 'default' : 'ghost'}
              onClick={() => addNode(createPropNode(kind, PROP_DEFINITIONS[kind].label))}
            >
              {PROP_DEFINITIONS[kind].label}
            </Button>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] leading-snug text-shell-400">
          Highlighted props suit the current stand treatment.
        </p>
      </Panel>
    </div>
  );
}
