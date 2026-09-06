import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStore } from '@/lib/db/local';
import { SupabaseStore } from '@/lib/db/supabase';
import { makeFurnitureSpec } from '../fixtures';

/**
 * The "accepted version is immutable" rule is enforced twice in this codebase:
 * a Postgres trigger (supabase/migrations/0001_init.sql,
 * `reject_accepted_version_edit`) for SupabaseStore, and a JS check in
 * LocalStore.updateAssetVersion. This test asserts both reject the same
 * mutation, and both allow the one mutation that must still work (explicitly
 * un-accepting a version).
 *
 * There's no live Postgres reachable from this sandbox (see
 * tests/db/supabase-store.test.ts for the full conformance suite, skipped for
 * the same reason), so the Supabase half runs against a minimal fake client
 * that ports the trigger's exact predicate to JS:
 *
 *   if old.accepted_at is not null and new.accepted_at is not null then raise ...
 *
 * Crucially, an ordinary SQL UPDATE carries every column NOT named in the SET
 * clause forward from OLD into NEW - so NEW.accepted_at stays whatever
 * OLD.accepted_at already was unless the update explicitly overwrites it.
 * That's why the fake below computes `newAcceptedAt` by falling back to the
 * existing row rather than only checking the patch, and it's why
 * LocalStore's own check (`patch.acceptedAt !== null`) has to treat an
 * *absent* acceptedAt in the patch the same as one left unchanged.
 */

interface FakeRow {
  id: string;
  accepted_at: string | null;
  [key: string]: unknown;
}

function makeAssetVersionsFakeClient() {
  const rows = new Map<string, FakeRow>();
  let counter = 0;

  return {
    from(table: string) {
      if (table !== 'asset_versions') {
        throw new Error(`fake Supabase client only supports asset_versions, got "${table}"`);
      }
      return {
        insert(payload: Record<string, unknown>) {
          const id = `fake-version-${(counter += 1)}`;
          const row: FakeRow = {
            id,
            created_at: new Date().toISOString(),
            accepted_at: null,
            ...payload,
          };
          return {
            select: () => ({
              single: async () => {
                rows.set(id, row);
                return { data: { ...row }, error: null };
              },
            }),
          };
        },
        select() {
          return {
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => {
                const row = rows.get(id);
                return { data: row ? { ...row } : null, error: null };
              },
            }),
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: (_col: string, id: string) => ({
              select: () => ({
                single: async () => {
                  const existing = rows.get(id);
                  if (!existing) return { data: null, error: { message: 'no rows' } };

                  // Port of reject_accepted_version_edit(): NEW inherits any
                  // column the UPDATE didn't name, exactly as Postgres does.
                  const newAcceptedAt = 'accepted_at' in patch ? patch.accepted_at : existing.accepted_at;
                  if (existing.accepted_at !== null && newAcceptedAt !== null) {
                    return {
                      data: null,
                      error: {
                        message: `asset_version ${id} is accepted and immutable; create a new version instead`,
                      },
                    };
                  }

                  const updated: FakeRow = { ...existing, ...patch, accepted_at: newAcceptedAt as string | null };
                  rows.set(id, updated);
                  return { data: { ...updated }, error: null };
                },
              }),
            }),
          };
        },
      };
    },
  };
}

let dir: string;
let local: LocalStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai3drender-immutability-'));
  local = new LocalStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('accepted asset version immutability', () => {
  it('LocalStore rejects a mutation to an accepted version, and allows explicitly un-accepting it', async () => {
    const project = await local.createProject({ ownerId: 'owner', name: 'P' });
    const asset = await local.createAsset({
      projectId: project.id,
      name: 'A',
      status: 'draft',
      currentVersionId: null,
      sourceImageIds: [],
    });
    const version = await local.createAssetVersion({
      assetId: asset.id,
      versionNumber: 1,
      label: 'v1',
      parentVersionId: null,
      spec: makeFurnitureSpec(),
      views: [],
      meshPath: null,
      previewMeshPath: null,
      previewPath: null,
      meshExtentMm: null,
      provider: 'stub',
      providerJobId: null,
      refinement: null,
      qaResult: null,
      acceptedAt: null,
    });

    await local.updateAssetVersion(version.id, { acceptedAt: new Date().toISOString() });

    await expect(local.updateAssetVersion(version.id, { label: 'renamed' })).rejects.toThrow(
      /accepted.*immutable/i,
    );

    const unaccepted = await local.updateAssetVersion(version.id, { acceptedAt: null });
    expect(unaccepted.acceptedAt).toBeNull();
  });

  it('SupabaseStore surfaces the same rejection (simulated Postgres trigger) and the same escape hatch', async () => {
    const supabase = new SupabaseStore(makeAssetVersionsFakeClient() as never);

    const version = await supabase.createAssetVersion({
      assetId: 'asset-1',
      versionNumber: 1,
      label: 'v1',
      parentVersionId: null,
      spec: makeFurnitureSpec(),
      views: [],
      meshPath: null,
      previewMeshPath: null,
      previewPath: null,
      meshExtentMm: null,
      provider: 'stub',
      providerJobId: null,
      refinement: null,
      qaResult: null,
      acceptedAt: null,
    });

    await supabase.updateAssetVersion(version.id, { acceptedAt: new Date().toISOString() });

    await expect(supabase.updateAssetVersion(version.id, { label: 'renamed' })).rejects.toThrow(
      /accepted.*immutable/i,
    );

    const unaccepted = await supabase.updateAssetVersion(version.id, { acceptedAt: null });
    expect(unaccepted.acceptedAt).toBeNull();
  });
});
