import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Dialog } from '@/components/common/dialog';
import { RevealOnceSecret } from './reveal-once-secret';

interface ResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Used in the dialog copy ("Reset the password for …" / "Share … with …"). */
  targetLabel: string;
  /**
   * Performs the reset. `password === undefined` means "auto-generate"; the
   * resolved string is the plaintext password to reveal exactly once. The
   * caller injects org scoping (X-Org-Id) here, so this dialog is reusable
   * across the single-org People page and the multi-org People Manager.
   */
  onReset: (password: string | undefined) => Promise<string>;
}

/**
 * Reset-password dialog — generate-or-manual, 12-char minimum, with a
 * show-once reveal of the resulting password. Extracted from the duplicated
 * copies in the People detail pages (plan §7 / §12 "duplicated reset-password
 * dialog") so the UX is identical everywhere.
 */
export function ResetPasswordDialog({
  open,
  onOpenChange,
  targetLabel,
  onReset,
}: ResetPasswordDialogProps) {
  const [mode, setMode] = useState<'generate' | 'manual'>('generate');
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: (password: string | undefined) => onReset(password),
    onSuccess: (password) => setResult(password),
  });

  const close = () => {
    onOpenChange(false);
    // Defer the form reset so it doesn't flash during the close animation.
    window.setTimeout(() => {
      setMode('generate');
      setManual('');
      setResult(null);
      reset.reset();
    }, 200);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={result ? 'Password reset complete' : 'Reset password'}
      description={
        result
          ? `Share this password with ${targetLabel}. It will not be shown again.`
          : `Reset the password for ${targetLabel}.`
      }
    >
      {!result ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            reset.mutate(mode === 'manual' ? manual : undefined);
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                checked={mode === 'generate'}
                onChange={() => setMode('generate')}
                className="mt-1"
              />
              <div>
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  Auto-generate a strong password
                </div>
                <div className="text-xs text-zinc-500">16 chars, alphanumeric</div>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                checked={mode === 'manual'}
                onChange={() => setMode('manual')}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  Enter a password manually
                </div>
                <div className="text-xs text-zinc-500 mb-2">Minimum 12 characters</div>
                {mode === 'manual' && (
                  <Input
                    type="text"
                    value={manual}
                    onChange={(e) => setManual(e.target.value)}
                    minLength={12}
                    autoFocus
                  />
                )}
              </div>
            </label>
          </div>

          {reset.isError && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
              {(reset.error as Error)?.message || 'Reset failed'}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={reset.isPending}
              disabled={mode === 'manual' && manual.length < 12}
            >
              Reset password
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <RevealOnceSecret secret={result} message="This password is shown only once. Copy it now." />
          <div className="flex items-center justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
