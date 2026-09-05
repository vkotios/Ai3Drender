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
} as const;

/** True when Supabase is configured; otherwise the on-disk LocalStore is used. */
export const hasSupabase = Boolean(env.supabaseUrl && env.supabaseAnonKey);

/** True when Gemini is configured; otherwise the offline analyzer is used. */
export const hasGemini = Boolean(env.geminiApiKey);

/**
 * The single user the app runs as when Supabase (and therefore auth) is absent.
 * Deliberately a fixed UUID so local data survives restarts.
 */
export const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';
export const LOCAL_USER_EMAIL = 'local@ai3drender.dev';
