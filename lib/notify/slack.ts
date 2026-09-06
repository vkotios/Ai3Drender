import { env, hasSlack } from '@/lib/env';

export { hasSlack };

/**
 * Post a plain-text message to the configured Slack Incoming Webhook
 * (https://api.slack.com/messaging/webhooks - a single POST of `{ text }`,
 * no SDK or app install needed).
 *
 * No-op when `SLACK_WEBHOOK_URL` is unset, and never throws: a notification
 * is a side effect of a client leaving a note or a verdict, not a
 * precondition for it, exactly like the mesh vendors and Gemini degrade to
 * an offline mode instead of failing the request that triggered them.
 */
export async function postSlackMessage(text: string): Promise<void> {
  if (!env.slackWebhookUrl) return;
  try {
    const response = await fetch(env.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error(`[notify] Slack webhook responded ${response.status}: ${await response.text()}`);
    }
  } catch (cause) {
    console.error('[notify] Slack webhook post failed', cause);
  }
}
