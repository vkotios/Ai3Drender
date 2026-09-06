import { describe, expect, it } from 'vitest';

import { bomFilename, bomRowsToCsv, buildBomRows } from '@/lib/bom';
import type { MaterialLibraryEntry } from '@/lib/types';
import { makeComponent, makeFurnitureSpec, makeMaterial } from './fixtures';

function makeLibraryEntry(overrides: Partial<MaterialLibraryEntry> = {}): MaterialLibraryEntry {
  return {
    id: 'lib-1',
    ownerId: 'owner-a',
    name: 'Solid Oak',
    code: 'OAK-014',
    kind: 'wood',
    baseColorHex: '#8B5A2B',
    roughness: 0.55,
    metalness: 0,
    sheen: 0,
    clearcoat: 0.25,
    finish: 'oiled',
    notes: '',
    swatchPath: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildBomRows', () => {
  it('gives the four-leg role a quantity of 4, matching the massing generator', () => {
    const spec = makeFurnitureSpec({
      components: [makeComponent({ name: 'Legs', role: 'leg', materialId: 'frame' })],
      materials: [makeMaterial({ id: 'frame' })],
    });
    const rows = buildBomRows(spec, new Map());
    expect(rows).toEqual([
      { component: 'Legs', role: 'leg', quantity: 4, material: 'invented — no library match', code: '' },
    ]);
  });

  it('reports name and code for a component bound to a library entry', () => {
    const entry = makeLibraryEntry({ id: 'lib-oak', code: 'OAK-014', name: 'Solid Oak' });
    const spec = makeFurnitureSpec({
      components: [makeComponent({ name: 'Legs', role: 'leg', materialId: 'frame' })],
      materials: [
        makeMaterial({ id: 'frame', name: 'Solid Oak', libraryEntryId: 'lib-oak', invented: false }),
      ],
    });
    const rows = buildBomRows(spec, new Map([['lib-oak', entry]]));
    expect(rows).toEqual([
      { component: 'Legs', role: 'leg', quantity: 4, material: 'Solid Oak', code: 'OAK-014' },
    ]);
  });

  it('flags a component whose material was invented (no library match) rather than hiding it', () => {
    const spec = makeFurnitureSpec({
      components: [makeComponent({ name: 'Seat', role: 'seat', materialId: 'upholstery' })],
      materials: [makeMaterial({ id: 'upholstery', name: 'Wool blend', libraryEntryId: null, invented: true })],
    });
    const rows = buildBomRows(spec, new Map());
    expect(rows[0]).toMatchObject({ material: 'invented — no library match', code: '' });
  });

  it('leaves the code blank when the library entry itself has none, without falling back to "invented"', () => {
    const entry = makeLibraryEntry({ id: 'lib-no-code', code: null });
    const spec = makeFurnitureSpec({
      components: [makeComponent({ name: 'Backrest', role: 'backrest', materialId: 'upholstery' })],
      materials: [
        makeMaterial({ id: 'upholstery', name: 'House fabric', libraryEntryId: 'lib-no-code', invented: false }),
      ],
    });
    const rows = buildBomRows(spec, new Map([['lib-no-code', entry]]));
    expect(rows[0]).toMatchObject({ material: 'House fabric', code: '' });
  });

  it('marks a component whose materialId does not resolve to any spec material', () => {
    const spec = makeFurnitureSpec({
      components: [makeComponent({ name: 'Mystery part', role: 'frame', materialId: 'no-such-id' })],
      materials: [makeMaterial({ id: 'frame' })],
    });
    const rows = buildBomRows(spec, new Map());
    expect(rows[0]).toMatchObject({ material: '(no material assigned)', code: '' });
  });

  it('gives a two-instance role (armrests) a quantity of 2 and a single-instance role a quantity of 1', () => {
    const spec = makeFurnitureSpec({
      components: [
        makeComponent({ name: 'Arms', role: 'armrest', materialId: 'frame' }),
        makeComponent({ name: 'Top', role: 'top', materialId: 'frame' }),
      ],
      materials: [makeMaterial({ id: 'frame' })],
    });
    const rows = buildBomRows(spec, new Map());
    expect(rows.map((r) => r.quantity)).toEqual([2, 1]);
  });
});

describe('bomRowsToCsv', () => {
  it('renders a header row plus one row per component, quoting fields that need it', () => {
    const csv = bomRowsToCsv([
      { component: 'Legs', role: 'leg', quantity: 4, material: 'Solid Oak', code: 'OAK-014' },
      { component: 'Seat, cushion', role: 'seat', quantity: 1, material: 'invented — no library match', code: '' },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Component,Role,Quantity,Material,Code');
    expect(lines[1]).toBe('Legs,leg,4,Solid Oak,OAK-014');
    expect(lines[2]).toBe('"Seat, cushion",seat,1,invented — no library match,');
    expect(lines[3]).toBe(''); // trailing CRLF
  });

  it('escapes embedded quotes by doubling them', () => {
    const csv = bomRowsToCsv([
      { component: 'Panel "A"', role: 'panel', quantity: 2, material: 'x', code: '' },
    ]);
    expect(csv).toContain('"Panel ""A"""');
  });
});

describe('bomFilename', () => {
  it('slugifies the display name and appends the version number', () => {
    expect(bomFilename('Lounge Chair', 3)).toBe('lounge-chair-v3-bom.csv');
  });

  it('falls back to a generic name when the display name has no usable characters', () => {
    expect(bomFilename('   ', 1)).toBe('parts-list-v1-bom.csv');
  });
});
