'use client';

import { useEffect, useState } from 'react';

import { Badge, Button, TextInput } from '@/components/ui';
import type { SceneShareLink } from '@/lib/types';

/**
 * Owner-facing control for client review links: generate, list, revoke.
 *
 * The token only ever exists in clear text in the response to the POST that
 * created it - after that this panel (like the database) only ever sees the
 * link row, never the bearer value, so "copy link" only works in the moment
 * right after generating one.
 */
export function SharePanel({ sceneId, onClose }: { sceneId: string; onClose: () => void }) {
  const [links, setLinks] = useState<SceneShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('14');
  const [justCreated, setJustCreated] = useState<{ url: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scenes/${sceneId}/share`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => !cancelled && setLinks(data))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sceneId]);

  async function createLink() {
    setBusy(true);
    setError(null);
    setJustCreated(null);
    try {
      const days = expiresInDays.trim() ? Number(expiresInDays) : null;
      const response = await fetch(`/api/scenes/${sceneId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || null, expiresInDays: days }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not create the link');
      const { link, url } = await response.json();
      setLinks((current) => [link, ...current]);
      setJustCreated({ url, label: link.label ?? 'Untitled link' });
      setLabel('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the link');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(linkId: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/scenes/${sceneId}/share/${linkId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not revoke the link');
      const updated: SceneShareLink = await response.json();
      setLinks((current) => current.map((l) => (l.id === linkId ? updated : l)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke the link');
    } finally {
      setBusy(false);
    }
  }

  const linkStatus = (link: SceneShareLink) => {
    if (link.revokedAt) return { label: 'Revoked', tone: 'bad' as const };
    if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) {
      return { label: 'Expired', tone: 'bad' as const };
    }
    return { label: 'Active', tone: 'good' as const };
  };

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute right-0 z-20 mt-1 w-96 rounded-lg border border-shell-700 bg-shell-850 p-3.5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-shell-400">
            Client review links
          </h2>
          <button onClick={onClose} className="text-xs text-shell-500 hover:text-shell-100">
            Close
          </button>
        </div>

        <p className="mb-3 text-[11px] leading-relaxed text-shell-400">
          Anyone with this link can orbit the scene, pin notes, and sign off - read-only, no
          account needed. They cannot stage pieces, edit, save or export.
        </p>

        {justCreated && (
          <div className="mb-3 rounded-md border border-emerald-900/60 bg-emerald-950/40 p-2.5">
            <p className="mb-1.5 text-[11px] text-emerald-300">
              Link created for &quot;{justCreated.label}&quot;. Copy it now - it will not be shown again.
            </p>
            <div className="flex gap-1.5">
              <TextInput readOnly value={justCreated.url} onFocus={(e) => e.currentTarget.select()} />
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(justCreated.url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {
                    // Clipboard access can be denied; the field itself is still selectable.
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p className="mb-3 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-[11px] text-red-300">
            {error}
          </p>
        )}

        <div className="mb-3 flex gap-1.5">
          <TextInput
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label, e.g. Acme Corp"
          />
          <TextInput
            className="w-20 shrink-0"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="Days"
          />
          <Button size="sm" variant="primary" onClick={createLink} disabled={busy}>
            Create
          </Button>
        </div>

        {loading ? (
          <p className="text-xs text-shell-500">Loading…</p>
        ) : links.length === 0 ? (
          <p className="text-xs text-shell-500">No links yet.</p>
        ) : (
          <ul className="max-h-64 space-y-1.5 overflow-y-auto">
            {links.map((link) => {
              const status = linkStatus(link);
              return (
                <li
                  key={link.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-shell-800 px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs text-shell-100">{link.label ?? 'Untitled link'}</p>
                    <p className="text-[11px] text-shell-500">
                      {link.expiresAt ? `Expires ${new Date(link.expiresAt).toLocaleDateString()}` : 'No expiry'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {status.label === 'Active' && (
                      <Button size="sm" variant="danger" onClick={() => revoke(link.id)} disabled={busy}>
                        Revoke
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
