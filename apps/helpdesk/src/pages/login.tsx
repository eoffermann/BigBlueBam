import { useState, useEffect } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { api } from '@/lib/api';

interface LoginPageProps {
  onNavigate: (path: string) => void;
}

export function LoginPage({ onNavigate }: LoginPageProps) {
  const { login, error, clearError } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signupDisabled, setSignupDisabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Helpdesk reads its OWN signup flag (helpdesk_signup_disabled), not the
    // Bam-internal one. The two are decoupled — closing internal signup
    // during beta should not block customers from filing tickets.
    api
      .get<{
        data: {
          public_signup_disabled: boolean;
          helpdesk_signup_disabled?: boolean;
        };
      }>('/public/config')
      .then((res) => {
        if (cancelled) return;
        // Prefer the helpdesk-specific flag; fall back to false if a stale
        // helpdesk-api hasn't been redeployed with the new field yet.
        setSignupDisabled(res.data.helpdesk_signup_disabled === true);
      })
      .catch(() => {
        /* leave default; register endpoint will reject if needed */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setIsSubmitting(true);
    try {
      await login(email, password);
      onNavigate('/tickets');
    } catch {
      // error is set in the store
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-primary-600 text-white font-bold text-2xl mb-4 shadow-lg shadow-primary-600/30">
            B
          </div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Welcome back</h1>
          <p className="text-zinc-500 mt-1">Sign in to BigBlueBam Helpdesk</p>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-lg px-4 py-3">
                {error}
              </div>
            )}

            <Input
              id="email"
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />

            <Input
              id="password"
              label="Password"
              type="password"
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />

            <Button type="submit" loading={isSubmitting} className="w-full mt-2">
              Sign In
            </Button>
          </form>
        </div>

        <p className="text-center text-sm text-zinc-500 mt-6">
          Don&apos;t have an account?{' '}
          <button
            onClick={() => {
              if (signupDisabled) {
                // Cross-app link to the shared beta-gate page under /b3.
                window.location.href = '/b3/beta-gate';
              } else {
                onNavigate('/register');
              }
            }}
            className="text-primary-600 font-medium hover:text-primary-700"
          >
            Create one
          </button>
        </p>
      </div>
    </div>
  );
}
