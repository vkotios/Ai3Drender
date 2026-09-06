import { createClient } from '@supabase/supabase-js';
import { describe } from 'vitest';

import { SupabaseStore } from '@/lib/db/supabase';
import { defineStoreConformance } from './conformance';

/**
 * Runs the exact same conformance suite as tests/db/local-store.test.ts
 * against a real SupabaseStore, so the two backends can't silently drift.
 *
 * There is no live Supabase project reachable from this sandbox, so this
 * suite is SKIPPED unless SUPABASE_TEST_URL and
 * SUPABASE_TEST_SERVICE_ROLE_KEY point at one with the migrations in
 * supabase/migrations/ already applied (a local `supabase start` stack works
 * fine - use its service_role key). When run, each test creates its own
 * project/asset/etc. with random-ish owner ids and never cleans up; point
 * this only at a disposable project, not production.
 *
 * The accepted-version immutability rule specifically (Postgres trigger vs.
 * LocalStore's JS check) is covered even without a live project - see
 * tests/db/asset-version-immutability.test.ts, which simulates the trigger.
 */
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

describe.skipIf(!url || !serviceKey)('SupabaseStore conformance (requires SUPABASE_TEST_URL)', () => {
  defineStoreConformance(() => new SupabaseStore(createClient(url!, serviceKey!)));
});

if (!url || !serviceKey) {
  console.log(
    '[tests] Skipping SupabaseStore conformance: set SUPABASE_TEST_URL and ' +
      'SUPABASE_TEST_SERVICE_ROLE_KEY to run it against a real (ideally local, ' +
      'disposable) Supabase project.',
  );
}
