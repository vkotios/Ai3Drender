'use client';

import { useState } from 'react';

import { Badge, Button, Empty, Field, Panel, Slider, TextInput } from '@/components/ui';
import type { MaterialLibraryUsage } from '@/lib/db/store';
import { MATERIAL_KINDS } from '@/lib/materials';
import type { MaterialKind, MaterialLibraryEntry } from '@/lib/types';

const selectClass =
  'w-full rounded-md border border-shell-700 bg-shell-850 px-2.5 py-1.5 text-sm text-shell-100 focus:border-shell-400 focus:outline-none';

interface Props {
  initialEntries: MaterialLibraryEntry[];
  swatchUrls: Record<string, string>;
}

export function MaterialLibrary({ initialEntries, swatchUrls }: Props) {
  const [entries, setEntries] = useState(initialEntries);
  const [urls, setUrls] = useState(swatchUrls);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch('/api/materials?includeArchived=true');
    if (response.ok) setEntries(await response.json());
  }

  async function archive(entry: MaterialLibraryEntry, archived: boolean) {
    const response = await fetch(`/api/materials/${entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    if (!response.ok) {
      setError((await response.json()).error ?? 'Could not update');
      return;
    }
    await refresh();
  }

  async function remove(entry: MaterialLibraryEntry) {
    const response = await fetch(`/api/materials/${entry.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError((await response.json()).error ?? 'Could not delete');
      return;
    }
    setEntries((current) => current.filter((e) => e.id !== entry.id));
  }

  async function uploadSwatch(entry: MaterialLibraryEntry, file: File) {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(`/api/materials/${entry.id}/swatch`, {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      setError((await response.json()).error ?? 'Could not upload swatch');
      return;
    }
    const { swatchUrl } = (await response.json()) as { swatchUrl: string };
    setUrls((current) => ({ ...current, [entry.id]: swatchUrl }));
  }

  const active = entries.filter((e) => !e.archivedAt);
  const archived = entries.filter((e) => e.archivedAt);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        {error && (
          <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <Panel title={`Materials (${active.length})`}>
          {active.length === 0 ? (
            <Empty title="No materials yet">
              Add the fabrics, timbers and finishes this account uses, or promote one the vision
              pass invented while reconstructing a piece.
            </Empty>
          ) : (
            <ul className="space-y-2">
              {active.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  swatchUrl={urls[entry.id]}
                  onArchive={() => archive(entry, true)}
                  onDelete={() => remove(entry)}
                  onSwatchUpload={(file) => uploadSwatch(entry, file)}
                />
              ))}
            </ul>
          )}
        </Panel>

        {archived.length > 0 && (
          <Panel title={`Discontinued (${archived.length})`}>
            <ul className="space-y-2">
              {archived.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  swatchUrl={urls[entry.id]}
                  onUnarchive={() => archive(entry, false)}
                  onDelete={() => remove(entry)}
                  onSwatchUpload={(file) => uploadSwatch(entry, file)}
                />
              ))}
            </ul>
          </Panel>
        )}
      </div>

      <Panel title="Add a material">
        <CreateForm
          onCreated={(entry) => {
            setEntries((current) => [...current, entry]);
            setError(null);
          }}
          onError={setError}
        />
      </Panel>
    </div>
  );
}

function EntryRow({
  entry,
  swatchUrl,
  onArchive,
  onUnarchive,
  onDelete,
  onSwatchUpload,
}: {
  entry: MaterialLibraryEntry;
  swatchUrl?: string;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
  onSwatchUpload: (file: File) => void;
}) {
  const [usage, setUsage] = useState<MaterialLibraryUsage[] | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  async function toggleUsage() {
    if (usage !== null) {
      setUsage(null);
      return;
    }
    setLoadingUsage(true);
    try {
      const response = await fetch(`/api/materials/${entry.id}/usage`);
      setUsage(response.ok ? await response.json() : []);
    } finally {
      setLoadingUsage(false);
    }
  }

  return (
    <li className="rounded-lg border border-shell-800 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <label
            className="relative block h-9 w-9 shrink-0 cursor-pointer overflow-hidden rounded-md border border-shell-700"
            title="Upload a reference swatch photo"
          >
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onSwatchUpload(file);
                e.target.value = '';
              }}
            />
            {swatchUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={swatchUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="block h-full w-full" style={{ background: entry.baseColorHex }} />
            )}
          </label>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-shell-100">{entry.name}</span>
              <Badge>{entry.kind}</Badge>
              {entry.archivedAt && <Badge tone="warn">discontinued</Badge>}
            </div>
            <p className="mt-0.5 truncate text-xs text-shell-400">
              {entry.code ? `${entry.code} · ` : ''}
              {entry.finish || 'no finish noted'} · roughness {entry.roughness.toFixed(2)} ·
              metalness {entry.metalness.toFixed(2)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="ghost" onClick={toggleUsage}>
            {loadingUsage ? '…' : usage === null ? 'Usage' : 'Hide'}
          </Button>
          {onArchive && (
            <Button size="sm" variant="ghost" onClick={onArchive}>
              Discontinue
            </Button>
          )}
          {onUnarchive && (
            <Button size="sm" variant="ghost" onClick={onUnarchive}>
              Restore
            </Button>
          )}
          {onDelete && (
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete
            </Button>
          )}
        </div>
      </div>

      {usage !== null && (
        <div className="mt-3 border-t border-shell-800 pt-3">
          {usage.length === 0 ? (
            <p className="text-xs text-shell-400">Not bound to any piece yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {usage.map((u) => (
                <li
                  key={`${u.assetVersionId}-${u.materialId}`}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="truncate text-shell-300">
                    {u.projectName} · {u.assetName} (v{u.versionNumber})
                    {!u.isCurrentVersion && ' · not current'}
                  </span>
                  <span className="shrink-0 truncate text-shell-500">
                    {u.components.map((c) => c.name).join(', ') || '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function CreateForm({
  onCreated,
  onError,
}: {
  onCreated: (entry: MaterialLibraryEntry) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<MaterialKind>('wood');
  const [baseColorHex, setBaseColorHex] = useState('#8B5A2B');
  const [roughness, setRoughness] = useState(0.5);
  const [metalness, setMetalness] = useState(0);
  const [sheen, setSheen] = useState(0);
  const [clearcoat, setClearcoat] = useState(0);
  const [finish, setFinish] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const response = await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          code,
          kind,
          baseColorHex,
          roughness,
          metalness,
          sheen,
          clearcoat,
          finish,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not add material');
      onCreated(await response.json());
      setName('');
      setCode('');
      setFinish('');
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not add material');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="European oak, oiled"
          required
        />
      </Field>
      <Field label="Code" hint="Manufacturer SKU, optional.">
        <TextInput value={code} onChange={(e) => setCode(e.target.value)} placeholder="OAK-014" />
      </Field>
      <Field label="Kind">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as MaterialKind)}
          className={selectClass}
        >
          {MATERIAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Colour">
        <input
          type="color"
          className="h-8 w-full"
          value={baseColorHex}
          onChange={(e) => setBaseColorHex(e.target.value)}
        />
      </Field>
      <Field label="Finish">
        <TextInput
          value={finish}
          onChange={(e) => setFinish(e.target.value)}
          placeholder="oiled, brushed, powder-coated…"
        />
      </Field>
      <Slider label="Roughness" value={roughness} min={0} max={1} onChange={setRoughness} />
      <Slider label="Metalness" value={metalness} min={0} max={1} onChange={setMetalness} />
      <Slider label="Sheen" value={sheen} min={0} max={1} onChange={setSheen} />
      <Slider label="Clearcoat" value={clearcoat} min={0} max={1} onChange={setClearcoat} />
      <Button type="submit" variant="primary" className="w-full" disabled={pending || !name.trim()}>
        {pending ? 'Adding…' : 'Add material'}
      </Button>
    </form>
  );
}
