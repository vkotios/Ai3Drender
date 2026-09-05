import { NextResponse } from 'next/server';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { hasSupabase } from '@/lib/env';

/**
 * POST-only: a GET would let any image or link tag sign the user out.
 */
export async function POST(request: Request) {
  const { origin } = new URL(request.url);

  if (hasSupabase) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }

  // 303 so the browser follows with a GET rather than re-posting.
  return NextResponse.redirect(`${origin}/sign-in`, { status: 303 });
}
