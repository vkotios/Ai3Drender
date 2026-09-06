'use client';

import { Badge } from '@/components/ui';
import { CONFIDENCE_BADGE_TONE, assessSpecConfidence } from '@/lib/confidence';
import type { FurnitureSpec } from '@/lib/types';

/**
 * Per-generation confidence signal (issue #44) - a heuristic read of fields
 * the pipeline already produces (`dimensionConfidence`, per-material
 * `invented` flags), surfaced as one badge so a manufacturer can tell before
 * staging a piece whether it's likely to need a manual correction pass.
 *
 * This is an interim stand-in for a real vision-scored fidelity check
 * (issue #43); see lib/confidence.ts for the full rationale.
 */
export function ConfidenceBadge({ spec }: { spec: FurnitureSpec }) {
  const { label, tier, summary } = assessSpecConfidence(spec);
  return (
    <span title={summary}>
      <Badge tone={CONFIDENCE_BADGE_TONE[tier]}>{label}</Badge>
    </span>
  );
}
