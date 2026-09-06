import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `lib/env.ts` computes its exported `env` object once, at import time, from
 * `process.env` - so toggling `SLACK_WEBHOOK_URL` between tests means
 * re-mocking the module and re-importing `postSlackMessage` fresh each time,
 * not just editing `process.env`.
 */
async function importWithWebhookUrl(url: string | null) {
  vi.resetModules();
  vi.doMock('@/lib/env', () => ({ env: { slackWebhookUrl: url }, hasSlack: Boolean(url) }));
  return import('@/lib/notify/slack');
}

describe('postSlackMessage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@/lib/env');
    vi.resetModules();
  });

  it('no-ops when SLACK_WEBHOOK_URL is unset - no request is made', async () => {
    const { postSlackMessage } = await importWithWebhookUrl(null);
    await expect(postSlackMessage('Jane left a note')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a plain { text } JSON payload to the configured webhook URL', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    const { postSlackMessage } = await importWithWebhookUrl('https://hooks.slack.test/services/abc');

    await postSlackMessage('Jane left a note on "Booth 12 / Main stand"');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.test/services/abc');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ text: 'Jane left a note on "Booth 12 / Main stand"' });
  });

  it('never throws when the webhook responds with an error status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const { postSlackMessage } = await importWithWebhookUrl('https://hooks.slack.test/services/abc');

    await expect(postSlackMessage('hello')).resolves.toBeUndefined();
  });

  it('never throws when fetch itself rejects (webhook host unreachable)', async () => {
    fetchMock.mockRejectedValue(new Error('network unreachable'));
    const { postSlackMessage } = await importWithWebhookUrl('https://hooks.slack.test/services/abc');

    await expect(postSlackMessage('hello')).resolves.toBeUndefined();
  });
});
