import { P3SamProvider } from './p3sam';
import type { PartSegmentationProvider } from './types';

export type {
  PartSegment,
  PartSegmentationOptions,
  PartSegmentationProvider,
  PartSegmentationResult,
} from './types';
export { PartSegmentationProviderError } from './types';

/**
 * Evaluation-only registry, mirroring `lib/ai/mesh/index.ts`'s shape so a
 * second candidate (e.g. Point-SAM, evaluated on a sibling branch) can be
 * added here for a like-for-like comparison. Unlike `getMeshProvider`, there
 * is no env-driven "active" selection yet and no stub fallback - nothing in
 * the app calls this outside `scripts/eval-p3sam-segmentation.ts`, so a
 * missing/misconfigured provider should fail loudly rather than degrade.
 */
const PROVIDERS: Record<string, () => PartSegmentationProvider> = {
  p3sam: () => new P3SamProvider(),
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
