import { describe, expect, it } from 'vitest';

import { extractMentions, MENTION_PATTERN } from '@/lib/annotations/mentions';

describe('extractMentions', () => {
  it('captures a single @name', () => {
    expect(extractMentions('Slim this down, @jane')).toEqual(['jane']);
  });

  it('captures several distinct mentions in first-appearance order', () => {
    expect(extractMentions('@jane can you check with @bob? cc @jane')).toEqual(['jane', 'bob']);
  });

  it('allows dots and hyphens inside a name', () => {
    expect(extractMentions('ping @jane.doe and @bob-b')).toEqual(['jane.doe', 'bob-b']);
  });

  it('returns nothing when there is no mention', () => {
    expect(extractMentions('Slim this leg to 40mm square')).toEqual([]);
  });

  it('does not treat a bare @ as a mention', () => {
    expect(extractMentions('reach us @ the front desk')).toEqual([]);
  });
});

describe('MENTION_PATTERN', () => {
  it('splits a body into text/mention/text segments the panel can render distinctly', () => {
    expect('Slim this down, @jane please'.split(MENTION_PATTERN)).toEqual([
      'Slim this down, ',
      'jane',
      ' please',
    ]);
  });
});
