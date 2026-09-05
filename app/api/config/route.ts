import { json } from '@/lib/api';
import { listProviders } from '@/lib/ai/mesh';
import { hasGemini, hasSupabase } from '@/lib/env';

/**
 * What the deployment can actually do. The UI reads this to tell the user which
 * capabilities are live rather than silently producing placeholder output.
 */
export async function GET() {
  return json({
    storage: hasSupabase ? 'supabase' : 'local',
    vision: hasGemini ? 'gemini' : 'offline',
    viewSynthesis: hasGemini,
    meshProviders: listProviders(),
  });
}
