'use client';

import { useState } from 'react';

import { Badge, Button, Field, Panel, Slider, TextInput } from '@/components/ui';
import type { SceneRender } from '@/lib/types';

import { formatSamples } from './StudioShell';
import type { RenderMode, RenderSettings } from './StudioCanvas';

export interface StoredRender extends SceneRender {
  url: string;
}

/**
 * The two ways out of the viewport.
 *
 * Path tracing converges the actual scene, so it is geometrically true and
 * safe to show a buyer. The concept pass is an image model reinterpreting a
 * screenshot: fast and good-looking, but it will invent detail, so it is
 * labelled as a starting point rather than a record of the product.
 */
export function RenderPanel({
  renderMode,
  onRenderModeChange,
  settings,
  onSettingsChange,
  samples,
  converged,
  renders,
  onSaveRender,
  onConceptRender,
  conceptAvailable,
  busy,
}: {
  renderMode: RenderMode;
  onRenderModeChange: (mode: RenderMode) => void;
  settings: RenderSettings;
  onSettingsChange: (settings: RenderSettings) => void;
  samples: number;
  converged: boolean;
  renders: StoredRender[];
  onSaveRender: () => void;
  onConceptRender: (instruction: string) => void;
  conceptAvailable: boolean;
  busy: string | null;
}) {
  const [instruction, setInstruction] = useState('');
  const tracing = renderMode === 'pathtrace';

  return (
    <div className="space-y-3">
      <Panel
        title="Path-traced render"
        actions={
          tracing ? (
            <Badge tone={converged ? 'good' : 'busy'}>
              {converged ? 'converged' : `${formatSamples(samples)}/${settings.maxSamples}`}
            </Badge>
          ) : null
        }
      >
        <p className="mb-3 text-[11px] leading-relaxed text-shell-400">
          Renders the real scene with true light bounce and soft shadows. Geometrically faithful —
          this is the one to put in front of a buyer. Moving the camera restarts it.
        </p>

        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant={tracing ? 'default' : 'primary'}
            onClick={() => onRenderModeChange(tracing ? 'preview' : 'pathtrace')}
          >
            {tracing ? 'Back to preview' : 'Start render'}
          </Button>
          {tracing && (
            <Button size="sm" onClick={onSaveRender} disabled={samples === 0 || Boolean(busy)}>
              Save frame
            </Button>
          )}
        </div>

        {tracing && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-shell-800">
            <div
              className="h-full bg-amber-500 transition-all"
              style={{ width: `${Math.min(100, (samples / settings.maxSamples) * 100)}%` }}
            />
          </div>
        )}

        {!tracing && (
          <div className="mt-3 space-y-3">
            <Slider
              label="Target samples"
              value={settings.maxSamples}
              min={16}
              max={1024}
              step={16}
              onChange={(v) => onSettingsChange({ ...settings, maxSamples: v })}
            />
            <Slider
              label="Light bounces"
              value={settings.bounces}
              min={1}
              max={12}
              step={1}
              onChange={(v) => onSettingsChange({ ...settings, bounces: v })}
            />
            <Slider
              label="Resolution scale"
              value={settings.resolutionScale}
              min={0.25}
              max={1}
              step={0.05}
              onChange={(v) => onSettingsChange({ ...settings, resolutionScale: v })}
            />
            <p className="text-[11px] leading-snug text-shell-400">
              More samples means less noise and more time. Drop the resolution scale on a slower
              machine.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="Quick concept">
        <p className="mb-3 text-[11px] leading-relaxed text-shell-400">
          An image model repaints the current view in seconds. Good as a starting base for art
          direction.
        </p>
        <p className="mb-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-[11px] leading-snug text-amber-200">
          Not geometrically faithful — it will invent detail. Do not show it to a buyer as the
          product.
        </p>

        <Field label="Extra direction" hint="Optional.">
          <TextInput
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Late afternoon light, warmer walls"
          />
        </Field>

        <Button
          size="sm"
          className="mt-2 w-full"
          disabled={!conceptAvailable || Boolean(busy)}
          onClick={() => onConceptRender(instruction)}
        >
          {conceptAvailable ? 'Generate concept' : 'Needs GEMINI_API_KEY'}
        </Button>
      </Panel>

      {renders.length > 0 && (
        <Panel title={`Renders (${renders.length})`}>
          <ul className="grid grid-cols-2 gap-2">
            {renders.map((render) => (
              <li key={render.id}>
                <a href={render.url} target="_blank" rel="noreferrer" className="block group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={render.url}
                    alt={`${render.kind} render`}
                    className="aspect-video w-full rounded-md border border-shell-800 bg-shell-850 object-cover transition group-hover:border-shell-600"
                  />
                  <span className="mt-1 flex items-center justify-between text-[10px] text-shell-400">
                    <span>{render.kind === 'concept' ? 'Concept' : 'Path-traced'}</span>
                    {render.samples !== null && <span>{render.samples} spp</span>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
