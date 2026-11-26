/**
 * Read a stored invoice PDF from object storage (issues #134, #148).
 *
 * The bill-pdf-generate worker job renders the PDF, uploads it under
 * billInvoicePdfKey(invoiceId) from @bigbluebam/storage, and stores that key in
 * `bill_invoices.pdf_url`. This module reads it back through bill-api's shared
 * storage driver (./storage-driver.ts). It returns null (never throws) when
 * storage is not configured, the key is not this invoice's storage key, or the
 * object is missing or unreadable, so the download route can fall back to
 * rendering the PDF from the database.
 */

import { billInvoicePdfKey } from '@bigbluebam/storage';
import { getBillStorageDriver, __setBillStorageDriverForTests } from './storage-driver.js';

/** The storage key the worker writes for an invoice (single shared definition). */
export const invoicePdfKey = billInvoicePdfKey;

/**
 * A stream of the stored PDF for an invoice, or null when there is no readable
 * stored copy. Only the key the worker writes for THIS invoice is read, so a
 * tampered `pdf_url` cannot point the route at another object.
 */
export async function openStoredInvoicePdf(
  invoiceId: string,
  pdfUrl: string | null | undefined,
): Promise<NodeJS.ReadableStream | null> {
  const key = billInvoicePdfKey(invoiceId);
  if (pdfUrl !== key) return null;
  const driver = getBillStorageDriver();
  if (!driver) return null;
  try {
    const { stream } = await driver.getStream(key);
    return stream;
  } catch {
    return null;
  }
}

/** Test hook: forget the cached driver so env changes take effect. */
export function __resetInvoicePdfStorageForTests(): void {
  __setBillStorageDriverForTests(undefined);
}
