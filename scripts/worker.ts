/**
 * Standalone queue worker: `npm run worker`.
 *
 * Optional - the app drains its own queue via /api/jobs/tick. Run this when you
 * want reconstruction to continue independently of anyone having the studio
 * open, or to process a backlog.
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
