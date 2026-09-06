'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Empty } from '@/components/ui';
import type { Project } from '@/lib/types';

/** Every project the viewer owns, each with a delete action. */
export function ProjectsList({ initialProjects }: { initialProjects: Project[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function remove(project: Project) {
    if (
      !confirm(
        `Delete "${project.name}"? Every photograph, piece and stand in it goes with it.`,
      )
    ) {
      return;
    }
    setDeletingId(project.id);
    try {
      const response = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      setProjects((current) => current.filter((p) => p.id !== project.id));
    } catch {
      setDeletingId(null);
    }
  }

  if (projects.length === 0) {
    return (
      <Empty title="No projects yet">
        A project holds one exhibition: the photographs you upload, the pieces reconstructed
        from them, and the stands you stage.
      </Empty>
    );
  }

  return (
    <ul className="space-y-2">
      {projects.map((project) => (
        <li
          key={project.id}
          className="group flex items-start gap-2 rounded-lg border border-shell-800 bg-shell-900 px-4 py-3 transition hover:border-shell-600"
        >
          <Link href={`/projects/${project.id}`} className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-shell-100">{project.name}</span>
              <span className="text-[11px] text-shell-400">
                {new Date(project.updatedAt).toLocaleDateString()}
              </span>
            </div>
            {project.client && (
              <span className="mt-0.5 block text-xs text-shell-400">{project.client}</span>
            )}
          </Link>
          <button
            onClick={() => remove(project)}
            disabled={deletingId === project.id}
            title="Delete project"
            className="shrink-0 rounded px-1.5 py-1 text-xs text-shell-500 opacity-0 transition hover:bg-red-950 hover:text-red-300 group-hover:opacity-100 disabled:opacity-100"
          >
            {deletingId === project.id ? '…' : '✕'}
          </button>
        </li>
      ))}
    </ul>
  );
}
