// Invoice PDF URLs (issue #134).
//
// The SPA used to turn `pdf_url` (a storage key) into a /files/... URL, which
// 404'd and bypassed authorization. PDFs now come only from bill-api routes
// that check the caller's access to the invoice.

const API_BASE = '/bill/api/v1';

/** Authorized download (Content-Disposition: attachment). */
export function invoicePdfDownloadHref(invoiceId: string): string {
  return `${API_BASE}/invoices/${encodeURIComponent(invoiceId)}/pdf/download`;
}

/** Inline rendering for the in-page preview. */
export function invoicePdfPreviewSrc(invoiceId: string): string {
  return `${API_BASE}/invoices/${encodeURIComponent(invoiceId)}/pdf`;
}

/** Whether the invoice has a generated PDF to offer. */
export function hasInvoicePdf(pdfUrl: string | null | undefined): boolean {
  return Boolean(pdfUrl);
}
