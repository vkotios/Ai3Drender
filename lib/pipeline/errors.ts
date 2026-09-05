import { MeshProviderError } from '@/lib/ai/mesh';

/**
 * Whether a failed stage is worth trying again.
 *
 * The default is NOT to retry. Most things that go wrong in a stage are bad
 * input or a bug, and retrying those just burns vendor credits three times
 * instead of once. Retries are opt-in, for the failures that are genuinely
 * about the world being briefly unavailable.
 */

/** Raise this from a stage to say explicitly which kind of failure it is. */
export class StageError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StageError';
  }
}

/** Transport-level failures: the request never got a considered answer. */
const NETWORK_PATTERNS = [
  'fetch failed',
  'failed to fetch',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'socket hang up',
  'network error',
  'timed out',
  'aborted',
];

/**
 * Status codes worth a second attempt. 429 included: it is a "later", not a
 * "no".
 *
 * The code has to appear in status-like context - after a colon, or next to
 * the words status/code/http - so that an ordinary number in a message
 * ("width 500mm is out of range") is not mistaken for a server error.
 */
const RETRYABLE_STATUS =
  /(?::\s*|\b(?:status|code|http|error)\W{0,8})(408|409|425|429|500|502|503|504)\b/i;

/** Vendor-neutral phrases for "busy, come back later". */
const OVERLOAD_PATTERNS = [
  'rate limit',
  'ratelimit',
  'too many requests',
  'resource_exhausted',
  'resource exhausted',
  'overloaded',
  'service unavailable',
  'temporarily unavailable',
  'try again later',
];

export function isRetryable(error: unknown): boolean {
  if (error instanceof StageError) return error.retryable;

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  // Vendor adapters report HTTP status in the message, e.g. "submit failed: 503".
  const looksTransient =
    NETWORK_PATTERNS.some((p) => message.includes(p)) ||
    OVERLOAD_PATTERNS.some((p) => message.includes(p)) ||
    RETRYABLE_STATUS.test(message);

  // Vendor adapters report HTTP status in the message, e.g. "submit failed: 503".
  if (error instanceof MeshProviderError) return looksTransient;
  if (looksTransient) return true;

  // Anything else - a missing version, an unreadable image, a bug - is
  // deterministic: the same attempt would fail the same way.
  return false;
}

/**
 * How long to wait before the next attempt.
 *
 * Exponential from 15s, with jitter so several jobs failing against the same
 * vendor at once do not come back in lockstep and knock it over again.
 */
export function backoffMs(attempts: number): number {
  const base = 15_000 * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(base, 10 * 60_000);
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}
