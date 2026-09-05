'use client';

import { Badge, Field, Panel, Slider, TextInput } from '@/components/ui';
import { BOOTH_PRESETS, PROP_DEFINITIONS, getPreset } from '@/lib/scene/presets';
import { useStudio } from '@/lib/studio/store';
import type { SceneNode } from '@/lib/types';

const DEG = 180 / Math.PI;

/** Right-hand panel: whatever is selected, or the environment when nothing is. */
export function Inspector() {
  const doc = useStudio((s) => s.doc);
  const selectedId = useStudio((s) => s.selectedId);
  const node = doc?.nodes.find((n) => n.id === selectedId) ?? null;

  if (!doc) return null;
  return node ? <NodeInspector node={node} /> : <EnvironmentInspector />;
}

function NodeInspector({ node }: { node: SceneNode }) {
  const patchNode = useStudio((s) => s.patchNode);
  const removeNode = useStudio((s) => s.removeNode);
  const versions = useStudio((s) => s.versions);
  const loaded = node.assetVersionId ? versions[node.assetVersionId] : null;

  const setPosition = (axis: 'x' | 'y' | 'z', value: number) =>
    patchNode(node.id, {
      transform: { ...node.transform, position: { ...node.transform.position, [axis]: value } },
    });

  return (
    <div className="space-y-3">
      <Panel
        title="Selection"
        actions={
          <button
            onClick={() => removeNode(node.id)}
            className="text-[11px] text-red-400 hover:text-red-300"
          >
            Remove
          </button>
        }
      >
        <Field label="Name">
          <TextInput
            value={node.name}
            onChange={(e) => patchNode(node.id, { name: e.target.value })}
          />
        </Field>

        <label className="mt-3 flex items-center gap-2 text-xs text-shell-300">
          <input
            type="checkbox"
            checked={node.visible}
            onChange={(e) => patchNode(node.id, { visible: e.target.checked })}
            className="accent-shell-100"
          />
          Visible
        </label>
      </Panel>

      <Panel title="Placement">
        <div className="space-y-3">
          <Slider
            label="Across the stand (X)"
            value={node.transform.position.x}
            min={-8}
            max={8}
            step={0.05}
            unit=" m"
            onChange={(v) => setPosition('x', v)}
          />
          <Slider
            label="Depth (Z)"
            value={node.transform.position.z}
            min={-8}
            max={8}
            step={0.05}
            unit=" m"
            onChange={(v) => setPosition('z', v)}
          />
          <Slider
            label="Height (Y)"
            value={node.transform.position.y}
            min={0}
            max={3}
            step={0.01}
            unit=" m"
            onChange={(v) => setPosition('y', v)}
          />
          <Slider
            label="Rotation"
            value={Math.round(node.transform.rotation.y * DEG)}
            min={-180}
            max={180}
            step={1}
            unit="°"
            onChange={(v) =>
              patchNode(node.id, {
                transform: { ...node.transform, rotation: { ...node.transform.rotation, y: v / DEG } },
              })
            }
          />
        </div>
      </Panel>

      {loaded && <MaterialInspector node={node} />}

      {node.kind === 'prop' && node.propKind && (
        <Panel title="Prop">
          <p className="text-xs text-shell-400">
            {PROP_DEFINITIONS[node.propKind].label} —{' '}
            {PROP_DEFINITIONS[node.propKind].size.map((n) => `${n}m`).join(' × ')}
          </p>
          <div className="mt-3">
            <Field label="Colour">
              <input
                type="color"
                className="h-8 w-full"
                value={node.materialOverrides.prop?.baseColorHex ?? PROP_DEFINITIONS[node.propKind].colorHex}
                onChange={(e) =>
                  patchNode(node.id, {
                    materialOverrides: {
                      ...node.materialOverrides,
                      prop: { ...node.materialOverrides.prop, baseColorHex: e.target.value },
                    },
                  })
                }
              />
            </Field>
          </div>
        </Panel>
      )}
    </div>
  );
}

/**
 * Per-instance material overrides.
 *
 * These deliberately do not fork the asset version: changing a booth-specific
 * finish should not invalidate an approved product spec.
 */
function MaterialInspector({ node }: { node: SceneNode }) {
  const patchNode = useStudio((s) => s.patchNode);
  const versions = useStudio((s) => s.versions);
  const loaded = node.assetVersionId ? versions[node.assetVersionId] : null;
  if (!loaded) return null;

  const spec = loaded.version.spec;

  return (
    <Panel title="Materials">
      <div className="space-y-4">
        {spec.materials.map((material) => {
          const override = node.materialOverrides[material.name] ?? {};
          const set = (patch: Partial<typeof override>) =>
            patchNode(node.id, {
              materialOverrides: {
                ...node.materialOverrides,
                [material.name]: { ...override, ...patch },
              },
            });

          return (
            <div key={material.id} className="rounded-md border border-shell-800 p-2.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-shell-100">{material.name}</span>
                <Badge>{material.kind}</Badge>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="h-7 w-12"
                  value={override.baseColorHex ?? material.baseColorHex}
                  onChange={(e) => set({ baseColorHex: e.target.value })}
                />
                <span className="font-mono text-[11px] text-shell-400">
                  {(override.baseColorHex ?? material.baseColorHex).toUpperCase()}
                </span>
              </div>

              <div className="mt-2.5 space-y-2">
                <Slider
                  label="Roughness"
                  value={override.roughness ?? material.roughness}
                  min={0}
                  max={1}
                  onChange={(v) => set({ roughness: v })}
                />
                <Slider
                  label="Metalness"
                  value={override.metalness ?? material.metalness}
                  min={0}
                  max={1}
                  onChange={(v) => set({ metalness: v })}
                />
              </div>

              {Object.keys(override).length > 0 && (
                <button
                  className="mt-2 text-[11px] text-shell-400 hover:text-shell-100"
                  onClick={() => {
                    const next = { ...node.materialOverrides };
                    delete next[material.name];
                    patchNode(node.id, { materialOverrides: next });
                  }}
                >
                  Reset to spec
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function EnvironmentInspector() {
  const doc = useStudio((s) => s.doc)!;
  const patchEnvironment = useStudio((s) => s.patchEnvironment);
  const patchCamera = useStudio((s) => s.patchCamera);
  const setDoc = useStudio((s) => s.setDoc);
  const environment = doc.environment;

  return (
    <div className="space-y-3">
      <Panel title="Stand treatment">
        <Field label="Preset">
          <select
            value={environment.presetId}
            onChange={(e) => {
              const preset = getPreset(e.target.value);
              // Replace the whole environment: a preset is a coherent set of
              // surfaces and lighting, not a colour swap.
              setDoc({
                ...doc,
                environment: { presetId: preset.id, ...preset.environment },
              });
            }}
            className="w-full rounded-md border border-shell-700 bg-shell-850 px-2.5 py-1.5 text-sm text-shell-100 focus:border-shell-400 focus:outline-none"
          >
            {BOOTH_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="mt-2 text-[11px] leading-relaxed text-shell-400">
          {getPreset(environment.presetId).description}
        </p>
      </Panel>

      <Panel title="Surfaces">
        <div className="space-y-3">
          <ColorRow
            label="Walls"
            value={environment.wallColorHex}
            onChange={(v) => patchEnvironment({ wallColorHex: v })}
          />
          <ColorRow
            label="Floor"
            value={environment.floorColorHex}
            onChange={(v) => patchEnvironment({ floorColorHex: v })}
          />
          <ColorRow
            label="Background"
            value={environment.backgroundColorHex}
            onChange={(v) => patchEnvironment({ backgroundColorHex: v })}
          />

          <div className="flex gap-4 pt-1">
            {(['back', 'left', 'right'] as const).map((side) => (
              <label key={side} className="flex items-center gap-1.5 text-xs capitalize text-shell-300">
                <input
                  type="checkbox"
                  checked={environment.walls[side]}
                  onChange={(e) =>
                    patchEnvironment({ walls: { ...environment.walls, [side]: e.target.checked } })
                  }
                  className="accent-shell-100"
                />
                {side}
              </label>
            ))}
          </div>

          <label className="flex items-center gap-1.5 text-xs text-shell-300">
            <input
              type="checkbox"
              checked={environment.showGrid}
              onChange={(e) => patchEnvironment({ showGrid: e.target.checked })}
              className="accent-shell-100"
            />
            Layout grid
          </label>
        </div>
      </Panel>

      <Panel title="Booth size">
        <div className="space-y-3">
          <Slider
            label="Width"
            value={environment.boothWidth}
            min={3}
            max={20}
            step={0.5}
            unit=" m"
            onChange={(v) => patchEnvironment({ boothWidth: v })}
          />
          <Slider
            label="Depth"
            value={environment.boothDepth}
            min={3}
            max={20}
            step={0.5}
            unit=" m"
            onChange={(v) => patchEnvironment({ boothDepth: v })}
          />
          <Slider
            label="Height"
            value={environment.boothHeight}
            min={2.2}
            max={6}
            step={0.1}
            unit=" m"
            onChange={(v) => patchEnvironment({ boothHeight: v })}
          />
        </div>
      </Panel>

      <Panel title="Lighting">
        <div className="space-y-3">
          <Field label="Environment map">
            <select
              value={environment.hdriPreset}
              onChange={(e) => patchEnvironment({ hdriPreset: e.target.value })}
              className="w-full rounded-md border border-shell-700 bg-shell-850 px-2.5 py-1.5 text-sm text-shell-100 focus:border-shell-400 focus:outline-none"
            >
              {['studio', 'apartment', 'city', 'warehouse', 'lobby', 'dawn', 'sunset', 'night', 'park', 'forest'].map(
                (preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Slider
            label="Environment intensity"
            value={environment.hdriIntensity}
            min={0}
            max={3}
            onChange={(v) => patchEnvironment({ hdriIntensity: v })}
          />
          <Slider
            label="Ambient fill"
            value={environment.ambientIntensity}
            min={0}
            max={1.5}
            onChange={(v) => patchEnvironment({ ambientIntensity: v })}
          />
        </div>
      </Panel>

      <Panel title="Camera">
        <Slider
          label="Field of view"
          value={doc.camera.fov}
          min={18}
          max={80}
          step={1}
          unit="°"
          onChange={(v) => patchCamera({ fov: v })}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-shell-400">
          40° is close to a 35mm lens. Going much wider distorts furniture at the frame edges.
        </p>
      </Panel>
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-shell-300">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-shell-400">{value.toUpperCase()}</span>
        <input type="color" className="h-7 w-11" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}
