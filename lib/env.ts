/**
 * Environment access. Every optional integration degrades to an offline mode
 * rather than throwing at import time, so the app boots with an empty .env and
 * the whole pipeline can still be exercised end to end.
 */

const read = (key: string): string | null => {
  const value = process.env[key];
  return value && value.trim() !== '' ? value.trim() : null;
};

export const env = {
  supabaseUrl: read('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: read('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  supabaseServiceKey: read('SUPABASE_SERVICE_ROLE_KEY'),

  geminiApiKey: read('GEMINI_API_KEY'),
  geminiTextModel: read('GEMINI_TEXT_MODEL') ?? 'gemini-2.5-flash',
  geminiImageModel: read('GEMINI_IMAGE_MODEL') ?? 'gemini-2.5-flash-image',

  meshProvider: (read('MESH_PROVIDER') ?? 'stub').toLowerCase(),
  meshyApiKey: read('MESHY_API_KEY'),
  tripoApiKey: read('TRIPO_API_KEY'),
  falApiKey: read('FAL_API_KEY'),
  falMeshModel: read('FAL_MESH_MODEL') ?? 'fal-ai/hunyuan3d-v21',

  appUrl: read('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000',
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
