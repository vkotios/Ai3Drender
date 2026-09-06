import type { Store } from '@/lib/db';
import type { Job } from '@/lib/types';

/**
 * Split out of `index.ts` so stage modules that live in their own file (like
 * `render.ts`) can depend on this type without importing `index.ts` itself
 * and creating a cycle.
 */
export interface StageContext {
  store: Store;
  job: Job;
  report: (progress: number, message: string) => Promise<void>;
}
