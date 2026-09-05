'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button, Field, TextInput } from '@/components/ui';
import { env } from '@/lib/env';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

type Mode = 'password' | 'magic-link';

/**
 * Sign-in for the manufacturer's own team.
 *
 * Two methods on purpose. Passwords work immediately on a fresh Supabase
 * project, including one with no SMTP configured. Magic links avoid managing
 * passwords at all, but need working email delivery - and Supabase's built-in
 * sender is rate-limited hard enough that it cannot be the only route in.
 */
export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  /**
   * NEXT_PUBLIC_* values are inlined into the browser bundle at build time,
   * while the server reads them at runtime. Supplying them only at runtime
   * therefore produces a half-configured deployment: the server redirects
   * everyone here, but this form has no project to talk to.
   *
   * Checked after mount rather than during render, because during SSR the
   * server can see values the browser bundle lacks - assuming configured and
   * correcting on the client keeps the first paint matching the server.
   */
  const [browserConfigured, setBrowserConfigured] = useState(true);
  useEffect(() => {
    setBrowserConfigured(Boolean(env.supabaseUrl && env.supabaseAnonKey));
  }, []);
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);

    try {
      const supabase = createSupabaseBrowserClient();

      if (mode === 'magic-link') {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw error;
        setNotice(`Check ${email} for a sign-in link.`);
        return;
      }

      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      // The browser client has written the session cookies; refresh so the
      // server components re-render as the signed-in user.
      router.replace(next);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in');
    } finally {
      setPending(false);
    }
  }

  async function signUp() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw error;

      // With email confirmation switched on, Supabase returns a user but no
      // session - say so rather than appearing to hang.
      if (data.session) {
        router.replace(next);
        router.refresh();
      } else {
        setNotice(`Account created. Check ${email} to confirm it before signing in.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the account');
    } finally {
      setPending(false);
    }
  }

  if (!browserConfigured) {
    return (
      <div className="space-y-2 text-xs leading-relaxed text-amber-200">
        <p className="font-medium">This build cannot sign anyone in.</p>
        <p className="text-shell-400">
          The server is configured for Supabase, but{' '}
          <code className="text-shell-300">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
          <code className="text-shell-300">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> were not set when
          the app was built, so they are missing from the browser bundle.
        </p>
        <p className="text-shell-400">
          Rebuild with both variables present. They are needed at build time, not just at run
          time.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex rounded-md border border-shell-700 p-0.5">
        {(
          [
            ['password', 'Password'],
            ['magic-link', 'Email link'],
          ] as [Mode, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setMode(value);
              setError(null);
              setNotice(null);
            }}
            className={`flex-1 rounded px-2 py-1 text-xs transition ${
              mode === value ? 'bg-shell-700 text-shell-100' : 'text-shell-400 hover:text-shell-100'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Field label="Email">
        <TextInput
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          required
        />
      </Field>

      {mode === 'password' && (
        <Field label="Password">
          <TextInput
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </Field>
      )}

      {error && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md border border-emerald-900/60 bg-emerald-950/40 px-2.5 py-2 text-xs text-emerald-300">
          {notice}
        </p>
      )}

      <Button type="submit" variant="primary" className="w-full" disabled={pending || !email}>
        {pending ? 'Working…' : mode === 'magic-link' ? 'Email me a link' : 'Sign in'}
      </Button>

      {mode === 'password' && (
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={pending || !email || password.length < 8}
          onClick={signUp}
        >
          Create an account
        </Button>
      )}
    </form>
  );
}
