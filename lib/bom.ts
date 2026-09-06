import { instanceCountForRole } from '@/lib/ai/mesh/massing';
import type { FurnitureSpec, MaterialLibraryEntry } from '@/lib/types';

/**
 * A parts-list (bill of materials) export for an accepted asset version.
 *
 * Scope is deliberately narrow, matching issue #45: codes and quantities, no
 * pricing. One row per spec component - not per rendered mesh instance - with
 * the material it is bound to (name plus the library's manufacturer code,
 * when there is one) and how many physical instances that component expands
 * to, e.g. "Legs" x4. A component whose material was never matched against
 * the library says so plainly rather than silently omitting the code.
 */

export interface BomRow {
  component: string;
  role: string;
  quantity: number;
  material: string;
  code: string;
}

const UNBOUND_LABEL = 'invented — no library match';

/**
 * Build the parts-list rows for a spec.
 *
 * `libraryEntries` is keyed by `MaterialLibraryEntry.id` - the caller resolves
 * whichever entries the spec's materials are bound to (there are usually far
 * fewer distinct materials than components) and passes the lookup in, so this
 * stays a pure function with no store access of its own.
 */
export function buildBomRows(
  spec: FurnitureSpec,
  libraryEntries: ReadonlyMap<string, MaterialLibraryEntry>,
): BomRow[] {
  return spec.components.map((component) => {
    const material = spec.materials.find((m) => m.id === component.materialId) ?? null;
    const entry = material?.libraryEntryId ? (libraryEntries.get(material.libraryEntryId) ?? null) : null;

    return {
      component: component.name,
      role: component.role,
      quantity: instanceCountForRole(component.role),
      material: material ? (material.libraryEntryId ? material.name : UNBOUND_LABEL) : '(no material assigned)',
      code: entry?.code ?? '',
    };
  });
}

/** One field, quoted per RFC 4180 only when it needs to be. */
function csvField(value: string | number): string {
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** CRLF line endings and a header row, so the file opens cleanly in Excel too. */
export function bomRowsToCsv(rows: readonly BomRow[]): string {
  const header = ['Component', 'Role', 'Quantity', 'Material', 'Code'];
  const lines = [
    header,
    ...rows.map((row) => [row.component, row.role, row.quantity, row.material, row.code]),
  ];
  return lines.map((line) => line.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** A short, filesystem-safe name for the downloaded file. */
export function bomFilename(displayName: string, versionNumber: number): string {
  const slug = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'parts-list'}-v${versionNumber}-bom.csv`;
}
