import { drainJobs } from '@/lib/pipeline';
import { getWorkerStore } from '@/lib/db';
import { isAuthorizedCron, json, withSession } from '@/lib/api';

// Reconstruction polls a vendor for minutes at a time.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * Drain the job queue.
 *
 * This route is a *nudge*, not the primary drainer: the studio and workbench
 * call it while they have work outstanding, which is convenient for local
 * development where running a second process is friction, but it only fires
 * while somebody's tab happens to be open. In a real deployment, draining is
 * expected to happen one of two ways instead:
 *
 *   - `npm run worker` running as its own always-on process (see the
 *     README's deployment section for Railway/systemd/container examples).
 *   - A scheduled trigger hitting this route with `Authorization: Bearer
 *     $CRON_SECRET` when there's no always-on process to run — Vercel Cron
 *     (see `vercel.json`) or any external cron service.
 *
 * Claims are atomic (see `claimNextJob`), so the in-app poll, the standalone
 * worker and a scheduled trigger can all run at once with no risk of a job
 * being processed twice.
 */
export async function POST(request: Request) {
  if (isAuthorizedCron(request)) {
    const processed = await drainJobs(getWorkerStore());
    return json({ processed });
  }

  return withSession(async () => {
    // Work is claimed with the worker store: the job may belong to a stage that
    // needs to write rows the caller's own session is not scoped to.
    const processed = await drainJobs(getWorkerStore());
    return json({ processed });
  });
}
