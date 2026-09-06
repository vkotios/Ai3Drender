import { createHash, randomBytes } from 'node:crypto';

/**
 * Share link tokens.
 *
 * The raw token is a bearer credential - anyone holding the URL can view the
 * scene - so it is never stored in clear. Only its SHA-256 hash lives in the
 * database, the same way a password would; the raw value is handed back to
 * the owner exactly once, at creation time.
 */

/** 32 bytes of entropy, base64url so it drops straight into a URL path. */
export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
