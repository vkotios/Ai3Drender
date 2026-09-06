/**
 * @mentions inside an annotation body (issue #40).
 *
 * Recognizing and capturing who was named is all this does - the tag is
 * UI-only, matching the issue's scope. Actually notifying that person is
 * tracked separately as issue #46 and reads none of this.
 *
 * A mention is `@` followed by a run of word characters, dots or hyphens, so
 * "@jane", "@jane.doe" and "@jane-d" all match but a bare "@" or an email
 * address's domain half do not get swept in past the first run of it.
 * Shared between server (extracting `mentions` at write time) and the panel
 * (splitting `body` back apart to render each hit distinctly), so the two can
 * never disagree on what counts as a mention.
 */
export const MENTION_PATTERN = /@([a-zA-Z0-9][\w.-]{0,38})/g;

/** Every distinct name mentioned in `body`, in first-appearance order. */
export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    seen.add(match[1]);
  }
  return [...seen];
}
