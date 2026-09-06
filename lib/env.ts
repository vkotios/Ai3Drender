/**
 * Environment access. Every optional integration degrades to an offline mode
 * rather than throwing at import time, so the app boots with an empty .env and
 * the whole pipeline can still be exercised end to end.
 */

/**
 * Next.js replaces `process.env.NEXT_PUBLIC_*` in browser bundles only where
 * the property is accessed STATICALLY. A dynamic lookup - `process.env[key]` -
 * is left alone, and `process.env` is an empty object in the browser, so those
 * values would silently read as absent client-side however the app was built.
 *
 * Every variable is therefore named literally below. Non-public names resolve
 * to undefined in client bundles rather than leaking, which is what we want:
 * only the two NEXT_PUBLIC_ values are ever needed in the browser.
 */
const clean = (value: string | undefined): string | null =>
  value && value.trim() !== '' ? value.trim() : null;

/** Clamp a ratio-shaped env var into (0, 1], falling back to `fallback` when unset or unparsable. */
const cleanRatio = (value: string | undefined, fallback: number): number => {
  const parsed = Number(clean(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(1, parsed);
};

export const env = {
  supabaseUrl: clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  supabaseServiceKey: clean(process.env.SUPABASE_SERVICE_ROLE_KEY),

  geminiApiKey: clean(process.env.GEMINI_API_KEY),
  geminiTextModel: clean(process.env.GEMINI_TEXT_MODEL) ?? 'gemini-2.5-flash',
  geminiImageModel: clean(process.env.GEMINI_IMAGE_MODEL) ?? 'gemini-2.5-flash-image',

  meshProvider: (clean(process.env.MESH_PROVIDER) ?? 'stub').toLowerCase(),
  meshyApiKey: clean(process.env.MESHY_API_KEY),
  tripoApiKey: clean(process.env.TRIPO_API_KEY),
  falApiKey: clean(process.env.FAL_API_KEY),
  falMeshModel: clean(process.env.FAL_MESH_MODEL) ?? 'fal-ai/hunyuan3d-v21',

  appUrl: clean(process.env.NEXT_PUBLIC_APP_URL) ?? 'http://localhost:3000',

  /** Executable invoked for offline Blender/Cycles renders. */
  blenderBin: clean(process.env.BLENDER_BIN) ?? 'blender',
  /** Wall-clock budget for one offline render before the child process is killed. */
  blenderTimeoutMs: Number(clean(process.env.BLENDER_TIMEOUT_MS)) || 20 * 60_000,
  /** 'CPU' everywhere by default; set 'GPU' on a worker with a configured Cycles device. */
  blenderDevice: (clean(process.env.BLENDER_DEVICE) ?? 'CPU').toUpperCase(),

  /**
   * Target ratio (0-1) of vertices the viewport preview mesh keeps, passed to
   * `@gltf-transform/functions`'s `simplify` at `reconstruct` time - see
   * `lib/ai/mesh/simplify.ts`. 0.5 halves the vertex budget by default; the
   * full-detail mesh reconstruct also wrote is what the Blender render worker
   * and glTF/OBJ export keep using regardless of this setting.
   */
  viewportMeshSimplifyRatio: cleanRatio(process.env.VIEWPORT_MESH_SIMPLIFY_RATIO, 0.5),

  // Lets a scheduled trigger (Vercel Cron, or any external cron service) call
  // POST /api/jobs/tick without a signed-in session. Unset => that route only
  // accepts the studio's own authenticated poll, same as before this existed.
  // Also gates POST /api/notifications/reminders/tick, for the same reason.
  cronSecret: clean(process.env.CRON_SECRET),

  /** Slack Incoming Webhook URL. Unset => review activity is never posted. */
  slackWebhookUrl: clean(process.env.SLACK_WEBHOOK_URL),

  /**
   * Resend (https://resend.com) API key for owner/reminder emails. Unset =>
   * no email is ever sent - review activity is still visible in the studio
   * and (if configured) posted to Slack, it just isn't emailed.
   */
  resendApiKey: clean(process.env.RESEND_API_KEY),
  /** `from` address on outgoing notification emails. Needs a domain verified with Resend. */
  notificationsFromEmail: clean(process.env.NOTIFICATIONS_FROM_EMAIL) ?? 'notifications@ai3drender.dev',
  /** Days of no share-link activity before a reminder email is sent. */
  reminderThresholdDays: Number(clean(process.env.REMINDER_THRESHOLD_DAYS)) || 3,
} as const;

/** True when Supabase is configured; otherwise the on-disk LocalStore is used. */
export const hasSupabase = Boolean(env.supabaseUrl && env.supabaseAnonKey);

/** True when Gemini is configured; otherwise the offline analyzer is used. */
export const hasGemini = Boolean(env.geminiApiKey);

/** True when a Slack Incoming Webhook is configured. */
export const hasSlack = Boolean(env.slackWebhookUrl);

/** True when Resend is configured; otherwise every email send is a no-op. */
export const hasEmail = Boolean(env.resendApiKey);

/**
 * The single user the app runs as when Supabase (and therefore auth) is absent.
 * Deliberately a fixed UUID so local data survives restarts.
 */
export const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';
export const LOCAL_USER_EMAIL = 'local@ai3drender.dev';
