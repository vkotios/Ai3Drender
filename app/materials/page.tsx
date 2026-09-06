import Link from 'next/link';

import { MaterialLibrary } from '@/components/MaterialLibrary';
import { requireSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function MaterialsPage() {
  const session = await requireSession();
  const { store, viewer } = session;

  const entries = await store.listMaterialLibraryEntries(viewer.id, { includeArchived: true });
  const swatchUrls = Object.fromEntries(
    await Promise.all(
      entries
        .filter((e) => e.swatchPath)
        .map(async (e) => [e.id, await store.blobUrl(e.swatchPath!)]),
    ),
  ) as Record<string, string>;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <Link href="/" className="text-xs text-shell-400 transition hover:text-shell-100">
          ← Projects
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Material library</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-shell-300">
          The real fabrics, timbers, finishes and powder-coat colours this account actually uses.
          Analysing a new piece checks its materials against this list first, so the same oak reads
          the same way on every product it appears on.
        </p>
      </header>

      <MaterialLibrary initialEntries={entries} swatchUrls={swatchUrls} />
    </main>
  );
}
