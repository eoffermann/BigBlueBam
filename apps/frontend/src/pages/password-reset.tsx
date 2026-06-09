import { useState, type FormEvent } from 'react';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';

interface PasswordResetPageProps {
  /** Raw token from the URL query string. null when the user landed on the
   *  page without one (typical for self-serve "forgot password"). */
  token: string | null;
  onNavigate: (path: string) => void;
}

interface ConsumeResponse {
  data: {
    success: boolean;
    purpose: 'reset' | 'invite';
    email: string;
    message: string;
  };
}

interface RequestResponse {
  data: {
    success: boolean;
    message: string;
    smtp_configured: boolean;
  };
}

/**
 * Public page for the "send password reset link" flow.
 *
 * Modes:
 *   - With ?token=... → show "set a new password" form; on submit, calls
 *     /auth/password-reset/consume and burns the token.
 *   - Without ?token → show "request a reset link" form; calls
 *     /auth/password-reset/request, which is opaque-by-design (always 200).
 */
export function PasswordResetPage({ token, onNavigate }: PasswordResetPageProps) {
  if (token) {
    return <ConsumeForm token={token} onNavigate={onNavigate} />;
  }
  return <RequestForm onNavigate={onNavigate} />;
}

function ConsumeForm({
  token,
  onNavigate,
}: {
  token: string;
  onNavigate: (path: string) => void;
}) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ConsumeResponse['data'] | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (newPassword.length < 12) {
      setFormError('Password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<ConsumeResponse>('/auth/password-reset/consume', {
        token,
        new_password: newPassword,
      });
      setSuccess(res.data);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'EXPIRED') {
          setFormError('This reset link has expired. Please request a new one.');
        } else if (err.code === 'ALREADY_USED') {
          setFormError('This reset link has already been used. Please request a new one.');
        } else if (err.code === 'INVALID_TOKEN') {
          setFormError('This reset link is not valid.');
        } else if (err.code === 'VALIDATION_ERROR') {
          setFormError('The new password does not meet the requirements.');
        } else {
          setFormError(err.message || 'Could not reset password. Please try again.');
        }
      } else {
        setFormError('Could not reset password. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    const title =
      success.purpose === 'invite' ? 'Welcome to BigBlueBam' : 'Password reset complete';
    const body =
      success.purpose === 'invite'
        ? 'Your password is set. You can now log in.'
        : 'Your password has been reset. You can now log in.';
    return (
      <CenteredCard
        icon={<CheckCircle2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />}
        title={title}
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-6">{body}</p>
        <button
          onClick={() => onNavigate('/login')}
          className="w-full rounded-lg bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 text-sm shadow-sm shadow-primary-600/20"
        >
          Go to login
        </button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard title="Set a new password">
      <p className="text-sm text-zinc-500 mb-4">
        Pick a new password to use with your BigBlueBam account.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="new-password"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
          >
            New password
          </label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={12}
            disabled={submitting}
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-zinc-500">Must be at least 12 characters.</p>
        </div>
        <div>
          <label
            htmlFor="confirm-password"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
          >
            Confirm new password
          </label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={12}
            disabled={submitting}
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50"
          />
        </div>
        {formError && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-800 dark:text-red-300">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{formError}</span>
          </div>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 text-sm shadow-sm shadow-primary-600/20 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? 'Setting password...' : 'Set password'}
        </button>
      </form>
    </CenteredCard>
  );
}

function RequestForm({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<RequestResponse['data'] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api.post<RequestResponse>('/auth/password-reset/request', {
        email,
      });
      setDone(res.data);
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message || 'Could not submit request.');
      } else {
        setFormError('Could not submit request.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <CenteredCard
        icon={<CheckCircle2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />}
        title="Check your email"
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-6">{done.message}</p>
        {!done.smtp_configured && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>
              SMTP is not configured on this server, so the link could not be emailed. Ask
              an administrator to reset your password directly.
            </span>
          </div>
        )}
        <button
          onClick={() => onNavigate('/login')}
          className="w-full rounded-lg bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 text-sm shadow-sm shadow-primary-600/20"
        >
          Back to login
        </button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard title="Reset your password">
      <p className="text-sm text-zinc-500 mb-4">
        Enter the email on your BigBlueBam account and we'll send you a reset link.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={submitting}
            className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:opacity-50"
          />
        </div>
        {formError && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-800 dark:text-red-300">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>{formError}</span>
          </div>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 text-sm shadow-sm shadow-primary-600/20 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? 'Sending...' : 'Send reset link'}
        </button>
        <button
          type="button"
          onClick={() => onNavigate('/login')}
          className="w-full text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 mt-2"
        >
          Back to login
        </button>
      </form>
    </CenteredCard>
  );
}

function CenteredCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-primary-600 text-white font-bold text-2xl mb-4 shadow-lg shadow-primary-600/30">
            B
          </div>
          {icon && <div className="mb-3">{icon}</div>}
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{title}</h1>
        </div>
        <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
