// Object keys that more than one service must agree on. A key derived in two
// places drifts silently: issue #148 found the bill-pdf-generate worker job and
// bill-api's download route each building the invoice PDF key by hand, and the
// route pins `bill_invoices.pdf_url` to its own copy, so any divergence would
// have made every download quietly fall back to re-rendering.

export const BILL_INVOICE_PDF_PREFIX = 'bill/invoices';

/** Storage key of an invoice's rendered PDF: written by the worker, read by bill-api. */
export function billInvoicePdfKey(invoiceId: string): string {
  return `${BILL_INVOICE_PDF_PREFIX}/${invoiceId}.pdf`;
}
