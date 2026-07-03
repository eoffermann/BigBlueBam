import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';

interface VerifyEmailPageProps {
  /** Raw verification token from the URL path (/verify-email/:token). */
  token: string;
  onNavigate: (path: string) => void;
}

interface VerifyResponse {
  data: {
    email: string;
    verified: boolean;
  };
}

/**
 * Public landing page for the email-change confirmation link. The user clicks
 * the link emailed to their NEW address; we POST the token to finalize the
 * swap. Confirmation is the intent of the click, so we auto-submit on mount.
 * On success every session is invalidated server-side, so the page directs the
 * user to log in again with the new address.
 */
export function VerifyEmailPage({ token, onNavigate }: VerifyEmailPageProps) {
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [newEmail, setNewEmail] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Guard against React 18 StrictMode double-invoking the effect in dev, which
  // would fire the (single-use) token twice.
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    (async () => {
      try {
        const res = await api.post<VerifyResponse>(`/auth/verify-email/${token}`, {});
        setNewEmail(res.data.email);
        setStatus('success');
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'TOKEN_EXPIRED') {
            setErrorMessage(
              'This confirmation link has expired. Ask for the email change to be sent again.',
            );
          } else if (err.code === 'NOT_FOUND') {
            setErrorMessage(
              'This confirmation link is not valid — it may have already been used or been superseded by a newer request.',
            );
          } else {
            setErrorMessage(err.message || 'Could not confirm your new email. Please try again.');
          }
        } else {
          setErrorMessage('Could not confirm your new email. Please try again.');
        }
        setStatus('error');
      }
    })();
  }, [token]);

  if (status === 'verifying') {
    return (
      <CenteredCard title="Confirming your email">
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
          Confirming your new email address...
        </div>
      </CenteredCard>
    );
  }

  if (status === 'success') {
    return (
      <CenteredCard
        icon={<CheckCircle2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />}
        title="Email confirmed"
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-6">
          Your account email is now{' '}
          <strong className="text-zinc-900 dark:text-zinc-100">{newEmail}</strong>. For your
          security you have been signed out everywhere — please log in again with your new address.
        </p>
        <button
          type="button"
          onClick={() => onNavigate('/login')}
          className="w-full rounded-lg bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 text-sm shadow-sm shadow-primary-600/20"
        >
          Go to login
        </button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard
      icon={<AlertTriangle className="h-7 w-7 text-amber-600 dark:text-amber-400" />}
      title="Could not confirm email"
    >
      <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <span>{errorMessage}</span>
      </div>
      <button
        onClick={() => onNavigate('/login')}
        className="w-full rounded-lg bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 text-sm shadow-sm shadow-primary-600/20"
      >
        Back to login
      </button>
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
