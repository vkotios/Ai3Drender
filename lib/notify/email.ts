import { env, hasEmail } from '@/lib/env';

export { hasEmail };

const API = 'https://api.resend.com/emails';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Send a transactional email through Resend (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Chosen over Postmark/SES/SendGrid for the same reason the mesh vendors are
 * reached with plain `fetch`: one authenticated POST of JSON, no SDK, no
 * signing step, nothing to install. Postmark's API is equally simple and
 * would work as a drop-in replacement here if a deployment already has an
 * account with them - only this module and `RESEND_API_KEY` would need to
 * change.
 *
 * No-op when `RESEND_API_KEY` is unset, and never throws: see
 * `postSlackMessage` in `./slack` for why.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!env.resendApiKey) return;
  try {
    const response = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.notificationsFromEmail,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!response.ok) {
      console.error(`[notify] Resend responded ${response.status}: ${await response.text()}`);
    }
  } catch (cause) {
    console.error('[notify] Resend send failed', cause);
  }
}
