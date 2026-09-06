'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui';

export function DeleteProjectButton({ projectId, name }: { projectId: string; name: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    if (!confirm(`Delete "${name}"? Every photograph, piece and stand in it goes with it.`)) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      router.push('/');
      router.refresh();
    } catch {
      setDeleting(false);
    }
  }

  return (
    <Button size="sm" variant="danger" onClick={remove} disabled={deleting}>
      {deleting ? 'Deleting…' : 'Delete project'}
    </Button>
  );
}
