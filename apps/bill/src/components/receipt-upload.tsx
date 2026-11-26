// Receipt upload control for Bill expenses (issue #155).
//
// Calls POST /bill/api/v1/expenses/:id/receipt (multipart) through
// useUploadReceipt. Accepts the same types and size the API enforces, checks
// them in the browser first so a bad pick gets a plain message instead of a
// round trip, and reports the API's own message when the upload is refused.
import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useUploadReceipt } from '@/hooks/use-expenses';
import { ApiError } from '@/lib/api';

/** Mirrors RECEIPT_TYPES / MAX_FILE_SIZE in apps/bill-api/src (receipt-storage.ts, receipt.service.ts). */
export const RECEIPT_ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.pdf,.heic,.heif';
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/** A plain-language problem with the picked file, or null when it can be sent. */
export function receiptFileProblem(file: File): string | null {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!RECEIPT_ACCEPT.split(',').includes(ext)) {
    return 'Receipts can be a photo (JPG, PNG, GIF, WebP, HEIC) or a PDF.';
  }
  if (file.size > RECEIPT_MAX_BYTES) return 'That file is larger than 10 MB.';
  return null;
}

interface Props {
  expenseId: string;
  /** True when the expense already has a receipt (the button then says Replace). */
  hasReceipt?: boolean;
  onUploaded?: () => void;
}

export function ReceiptUploadButton({ expenseId, hasReceipt = false, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadReceipt();
  const [error, setError] = useState<string | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = receiptFileProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    try {
      await upload.mutateAsync({ id: expenseId, file });
      onUploaded?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The receipt could not be uploaded. Please try again.');
    }
  };

  const label = upload.isPending ? 'Uploading…' : hasReceipt ? 'Replace receipt' : 'Attach receipt';

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <input
        ref={inputRef}
        type="file"
        accept={RECEIPT_ACCEPT}
        className="hidden"
        aria-label={`Receipt file for expense ${expenseId}`}
        data-testid={`receipt-input-${expenseId}`}
        onChange={onPick}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={upload.isPending}
        className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 hover:text-green-700 disabled:opacity-50 dark:text-zinc-400"
      >
        <Upload className="h-3 w-3" />
        {label}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
