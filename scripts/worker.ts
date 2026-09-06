/**
 * Standalone queue worker: `npm run worker`.
 *
 * This is the intended primary drainer in a real deployment - reconstruction
 * is the stage most likely to take minutes, and someone closing the tab
 * should not stall it. Run this as its own always-on process (a Railway
 * "worker" service, a systemd unit, a second container command - see the
 * README's deployment section) alongside the web app.
 *
 * /api/jobs/tick still exists as a same-process nudge the studio polls while
 * it has work outstanding, which is enough for local development, but it only
 * runs while a tab happens to be open, so don't rely on it alone in
 * production. Claims are atomic, so this worker, the in-app poll, and a
 * scheduled trigger hitting /api/jobs/tick can all run at once safely.
 */
import { getWorkerStore } from '@/lib/db';
import { drainJobs } from '@/lib/pipeline';

const INTERVAL_MS = 3000;

async function main() {
  const store = getWorkerStore();
  console.log(`[worker] polling ${store.kind} store every ${INTERVAL_MS}ms`);

  let stopping = false;
  process.on('SIGINT', () => {
    console.log('\n[worker] finishing current job, then stopping');
    stopping = true;
  });

  while (!stopping) {
    try {
      const processed = await drainJobs(store, 5);
      if (processed > 0) console.log(`[worker] processed ${processed} job(s)`);
    } catch (cause) {
      console.error('[worker]', cause instanceof Error ? cause.message : cause);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  process.exit(0);
}

void main();
