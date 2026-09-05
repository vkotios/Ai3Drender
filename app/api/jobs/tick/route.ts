import { drainJobs } from '@/lib/pipeline';
import { getWorkerStore } from '@/lib/db';
import { json, withSession } from '@/lib/api';

// Reconstruction polls a vendor for minutes at a time.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Drain the job queue.
 *
 * The studio calls this while it has outstanding work, which keeps the app to a
 * single deployable with no separate worker. For heavier use run
 * `npm run worker` alongside, or point a scheduler at this route; the claim is
 * atomic either way, so several drainers can run at once.
 */
export async function POST() {
  return withSession(async () => {
    // Work is claimed with the worker store: the job may belong to a stage that
    // needs to write rows the caller's own session is not scoped to.
    const processed = await drainJobs(getWorkerStore());
    return json({ processed });
  });
}
