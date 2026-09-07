import { P3SamProvider } from './p3sam';
import { PointSamProvider } from './pointsam';
import type { PartSegmentationProvider } from './types';

export type {
  PartSegment,
  PartSegmentationInput,
  PartSegmentationProvider,
  PartSegmentationResult,
} from './types';
export { PartSegmentationProviderError } from './types';

/**
 * Evaluation-only registry, mirroring `lib/ai/mesh/index.ts`'s shape, for the
 * two candidates being compared for issue #57. Unlike `getMeshProvider`,
 * there is no env-driven "active" selection yet and no stub fallback -
 * nothing in the app calls this outside the `scripts/eval-*.ts` harnesses,
 * so a missing/misconfigured provider should fail loudly rather than
 * degrade.
 */
const PROVIDERS: Record<string, () => PartSegmentationProvider> = {
  p3sam: () => new P3SamProvider(),
  'point-sam': () => new PointSamProvider(),
};

export function getPartSegmentationProvider(name: string): PartSegmentationProvider {
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(`Unknown part-segmentation provider "${name}" (known: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  return factory();
}

export function listPartSegmentationProviders(): string[] {
  return Object.keys(PROVIDERS);
}
