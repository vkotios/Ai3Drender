import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { env, hasSupabase } from '@/lib/env';

/**
 * Paths reachable without a session. Everything else redirects to sign-in.
 * `/auth` covers the OAuth/magic-link callback and sign-out.
 */
const PUBLIC_PREFIXES = ['/sign-in', '/auth'];

const isPublic = (pathname: string) =>
  PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

/**
 * Refresh the auth cookies on every request, and gate protected routes.
 *
 * This is what makes server components work: they cannot write cookies, so
 * `createSupabaseServerClient` swallows its writes and relies on this running
 * first to keep the tokens fresh.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Local-disk mode has no auth at all - never gate anything.
  if (!hasSupabase) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.supabaseUrl!, env.supabaseAnonKey!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        // Write refreshed cookies onto the request as well, so anything later
        // in this same request sees them, then rebuild the response around it.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser validates against the auth server rather than trusting the cookie,
  // and refreshes the tokens as a side effect. Do not replace it with
  // getSession here: that reads the cookie without verifying it.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // API routes answer for themselves with a 401 - redirecting an XHR to an
  // HTML sign-in page would surface as a confusing parse error in the client.
  if (pathname.startsWith('/api/')) return response;

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = '';
    // Send them back where they were headed once they are through.
    url.searchParams.set('next', pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  if (user && pathname === '/sign-in') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}
