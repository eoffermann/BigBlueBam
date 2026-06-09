import { useEffect, useState } from 'react';
import { LoginForm } from '@/components/auth/login-form';
import { api } from '@/lib/api';

interface LoginPageProps {
  onNavigate: (path: string) => void;
}

export function LoginPage({ onNavigate }: LoginPageProps) {
  // Lookup the platform-wide signup flag on mount. When it's on, the
  // "Create one" link points at the beta-gate page instead of /register.
  // Defaults to open (false) so we fail permissive if the call errors out.
  const [signupDisabled, setSignupDisabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ data: { public_signup_disabled: boolean } }>('/public/config')
      .then((res) => {
        if (!cancelled) setSignupDisabled(res.data.public_signup_disabled === true);
      })
      .catch(() => {
        // Leave default. Worst case: a user clicks "Create one" and the
        // register endpoint rejects with SIGNUP_DISABLED anyway.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-primary-600 text-white font-bold text-2xl mb-4 shadow-lg shadow-primary-600/30">
            B
          </div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Welcome back</h1>
          <p className="text-zinc-500 mt-1">Sign in to your BigBlueBam account</p>
        </div>

        <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6">
          <LoginForm onSuccess={() => onNavigate('/')} />
          <div className="mt-4 text-right">
            <button
              onClick={() => onNavigate('/password-reset')}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              Forgot password?
            </button>
          </div>
        </div>

        <p className="text-center text-sm text-zinc-500 mt-6">
          Don&apos;t have an account?{' '}
          <button
            onClick={() => onNavigate(signupDisabled ? '/beta-gate' : '/register')}
            className="text-primary-600 font-medium hover:text-primary-700"
          >
            Create one
          </button>
        </p>
      </div>
    </div>
  );
}
