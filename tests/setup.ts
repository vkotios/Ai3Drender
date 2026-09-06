/**
 * Force offline/stub mode regardless of what the host environment happens to
 * have set. `lib/env.ts` reads `process.env` at import time, so this must run
 * before any test imports it (or anything that imports it) - `setupFiles`
 * guarantees that ordering.
 *
 * Without this, a sandbox that happens to export GEMINI_API_KEY or the
 * Supabase URL would silently switch the pipeline tests onto a real network
 * call instead of the deterministic offline path they're written to exercise.
 */
for (const key of [
  'GEMINI_API_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MESH_PROVIDER',
  'MESHY_API_KEY',
  'TRIPO_API_KEY',
  'FAL_API_KEY',
  'SLACK_WEBHOOK_URL',
  'RESEND_API_KEY',
]) {
  delete process.env[key];
}
