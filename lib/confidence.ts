import type { FurnitureSpec } from '@/lib/types';

/**
 * Heuristic confidence signal for one FurnitureSpec.
 *
 * This is deliberately simple: it reads two fields the pipeline already
 * produces - `dimensionConfidence` (set by the vision pass, or 'rough' for
 * every offline stub) and each material's `invented` flag (set when a
 * material had no match in the account's library) - and folds them into one
 * tier so a manufacturer can tell, before staging a piece, whether it is
 * likely to need a manual correction pass.
 *
 * It is explicitly an interim stand-in. The richer signal is a vision-scored
 * fidelity check that compares the finished mesh back against the source
 * photos (see `docs/competitive-gap-analysis.md` §03 and issue #43) - once
 * that lands it should feed into (or replace) this tier, not be bolted on
 * beside it.
 */
export type ConfidenceTier = 'high' | 'medium' | 'low';

const TIER_LABEL: Record<ConfidenceTier, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

/** Badge tone (see components/ui.tsx `Badge`) that reads well for each tier. */
export const CONFIDENCE_BADGE_TONE: Record<ConfidenceTier, 'good' | 'warn' | 'bad'> = {
  high: 'good',
  medium: 'warn',
  low: 'bad',
};

const TIER_RANK: Record<ConfidenceTier, number> = { high: 2, medium: 1, low: 0 };

/** The lower (more cautious) of two tiers. */
function worseOf(a: ConfidenceTier, b: ConfidenceTier): ConfidenceTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

export interface ConfidenceSignal {
  tier: ConfidenceTier;
  label: string;
  /** Plain-language reasons the tier isn't "high", in the order they were found. Empty when nothing was flagged. */
  reasons: string[];
  /** Reasons joined into one sentence, for a badge tooltip. Always non-empty. */
  summary: string;
}

/**
 * Fold a spec's existing confidence-shaped fields into one heuristic tier.
 *
 * Dimensions set the base tier ('stated' -> high, 'estimated' -> medium,
 * 'rough' -> low). Invented materials can only pull the tier down from
 * there, never up: a spec with stated dimensions but every material invented
 * is still flagged, because the manual pass it predicts is about materials,
 * not dimensions.
 */
export function assessSpecConfidence(spec: FurnitureSpec): ConfidenceSignal {
  const reasons: string[] = [];

  let tier: ConfidenceTier;
  if (spec.dimensionConfidence === 'stated') {
    tier = 'high';
  } else if (spec.dimensionConfidence === 'estimated') {
    tier = 'medium';
    reasons.push('Dimensions are estimated from an in-frame reference, not stated measurements.');
  } else {
    tier = 'low';
    reasons.push('Dimensions fall back to category conventions, not measured from the photos.');
  }

  const inventedCount = spec.materials.filter((m) => m.invented).length;
  if (inventedCount > 0) {
    const allInvented = inventedCount === spec.materials.length;
    tier = worseOf(tier, allInvented ? 'low' : 'medium');
    reasons.push(
      `${inventedCount} of ${spec.materials.length} material${spec.materials.length === 1 ? '' : 's'} ` +
        `${inventedCount === 1 ? 'was' : 'were'} invented, not matched against the material library.`,
    );
  }

  const summary =
    reasons.length > 0
      ? reasons.join(' ')
      : 'Dimensions were read directly from the photos and every material matched the library.';

  return { tier, label: TIER_LABEL[tier], reasons, summary };
}
