import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Same reasoning as tests/notify/slack.test.ts's helper. */
async function importWithResendKey(key: string | null) {
  vi.resetModules();
  vi.doMock('@/lib/env', () => ({
    env: { resendApiKey: key, notificationsFromEmail: 'notifications@ai3drender.dev' },
    hasEmail: Boolean(key),
  }));
  return import('@/lib/notify/email');
}

describe('sendEmail', () => {
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

  const message = {
    to: 'owner@example.com',
    subject: 'Jane left a note',
    text: 'Jane left a note on "Booth 12 / Main stand".',
    html: '<p>Jane left a note on "Booth 12 / Main stand".</p>',
  };

  it('no-ops when RESEND_API_KEY is unset - no request is made', async () => {
    const { sendEmail } = await importWithResendKey(null);
    await expect(sendEmail(message)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a Resend-shaped payload with the bearer key and configured from address', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    const { sendEmail } = await importWithResendKey('re_test_key');

    await sendEmail(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test_key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual({
      from: 'notifications@ai3drender.dev',
      to: ['owner@example.com'],
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  });

  it('never throws when Resend responds with an error status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: async () => 'invalid from address' });
    const { sendEmail } = await importWithResendKey('re_test_key');

    await expect(sendEmail(message)).resolves.toBeUndefined();
  });

  it('never throws when fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network unreachable'));
    const { sendEmail } = await importWithResendKey('re_test_key');

    await expect(sendEmail(message)).resolves.toBeUndefined();
  });
});
