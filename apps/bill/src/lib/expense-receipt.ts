// Expense receipt URLs (issue #145).
//
// Receipts are served only by the bill-api route that checks the caller may see
// the expense; the SPA never builds a /files/... URL for them.

const API_BASE = '/bill/api/v1';

/** Authorized receipt download (Content-Disposition: attachment). */
export function receiptDownloadHref(expenseId: string): string {
  return `${API_BASE}/expenses/${encodeURIComponent(expenseId)}/receipt`;
}

/** Whether a receipt file was uploaded for the expense. */
export function hasUploadedReceipt(expense: { receipt_uploaded_at?: string | null }): boolean {
  return Boolean(expense.receipt_uploaded_at);
}
