import { NextResponse } from 'next/server';

import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Where magic links and email confirmations land.
 *
 * Supabase sends the user here with a one-time code; exchanging it sets the
 * session cookies. Route handlers can write cookies, so this works where a
 * server component could not.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  // Supabase reports link failures (expired, already used) on the query string.
  const errorDescription = searchParams.get('error_description');
  if (errorDescription) {
    return NextResponse.redirect(
      `${origin}/sign-in?error=${encodeURIComponent(errorDescription)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/sign-in?error=${encodeURIComponent('That sign-in link was incomplete.')}`,
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/sign-in?error=${encodeURIComponent(error.message)}`);
  }

  return NextResponse.redirect(`${origin}${target}`);
}
