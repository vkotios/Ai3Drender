import Link from 'next/link';

import { AuthStatus } from '@/components/AuthStatus';
import { Empty, Panel } from '@/components/ui';
import { NewProjectForm } from '@/components/NewProjectForm';
import { requireSession } from '@/lib/auth';
import { hasGemini, hasSupabase, env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await requireSession();

  const projects = await session.store.listProjects(session.viewer.id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-10">
        <div className="mb-2 flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">ai3drender</h1>
          <div className="flex items-center gap-4">
            <Link
              href="/materials"
              className="text-xs text-shell-400 transition hover:text-shell-100"
            >
              Material library →
            </Link>
            <AuthStatus email={session.viewer.email} />
          </div>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-shell-400">
          Turn furniture photographs into specified, versioned 3D assets, then stage them in an
          exhibition environment and export the result as glTF, GLB or OBJ.
        </p>
        <CapabilityStrip />
      </header>

      <div className="grid gap-8 md:grid-cols-[1fr_20rem]">
        <section>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-shell-400">
            Projects
          </h2>
          {projects.length === 0 ? (
            <Empty title="No projects yet">
              A project holds one exhibition: the photographs you upload, the pieces reconstructed
              from them, and the stands you stage.
            </Empty>
          ) : (
            <ul className="space-y-2">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/projects/${project.id}`}
                    className="block rounded-lg border border-shell-800 bg-shell-900 px-4 py-3 transition hover:border-shell-600"
                  >
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
                </li>
              ))}
            </ul>
          )}
        </section>

        <Panel title="New project">
          <NewProjectForm />
        </Panel>
      </div>
    </main>
  );
}

/** Tells the operator what this deployment can actually do before they rely on it. */
function CapabilityStrip() {
  const items = [
    {
      label: 'Storage',
      value: hasSupabase ? 'Supabase' : 'Local disk',
      warn: !hasSupabase,
    },
    {
      label: 'Photo analysis',
      value: hasGemini ? 'Gemini' : 'Offline placeholder',
      warn: !hasGemini,
    },
    {
      label: 'Reconstruction',
      value: env.meshProvider === 'stub' ? 'Block models (stub)' : env.meshProvider,
      warn: env.meshProvider === 'stub',
    },
  ];

  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item.label}
          className={`rounded-md border px-2.5 py-1 text-[11px] ${
            item.warn
              ? 'border-amber-900/60 bg-amber-950/30 text-amber-200'
              : 'border-shell-800 bg-shell-900 text-shell-300'
          }`}
        >
          <span className="text-shell-400">{item.label}: </span>
          {item.value}
        </span>
      ))}
    </div>
  );
}
