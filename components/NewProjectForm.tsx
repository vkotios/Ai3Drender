'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Field, TextInput } from '@/components/ui';

export function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [brief, setBrief] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, client, brief }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Could not create project');
      const project = await response.json();
      router.push(`/projects/${project.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create project');
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Milan 2026 stand"
          required
        />
      </Field>
      <Field label="Client">
        <TextInput
          value={client}
          onChange={(e) => setClient(e.target.value)}
          placeholder="Optional"
        />
      </Field>
      <Field
        label="Art direction"
        hint="Steers both the material analysis and the stand treatment."
      >
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder="Warm, restrained, oak-forward. Buyers should read the joinery."
          className="w-full rounded-md border border-shell-700 bg-shell-850 px-2.5 py-1.5 text-sm text-shell-100 placeholder:text-shell-600 focus:border-shell-400 focus:outline-none"
        />
      </Field>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <Button type="submit" variant="primary" disabled={pending || !name.trim()} className="w-full">
        {pending ? 'Creating…' : 'Create project'}
      </Button>
    </form>
  );
}
