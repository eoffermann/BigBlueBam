/**
 * Read a stored invoice PDF from object storage (issue #134).
 *
 * The bill-pdf-generate worker job renders the PDF and uploads it to
 * `${S3_BUCKET}/bill/invoices/<invoice-id>.pdf`, storing that key in
 * `bill_invoices.pdf_url`. This module reads it back with the same S3_*
 * settings the worker writes with. It returns null (never throws) when storage
 * is not configured, the key is not a storage key, or the object is missing or
 * unreadable, so the download route can fall back to rendering the PDF from
 * the database.
 */

import type { Readable } from 'node:stream';
import { Client as MinioClient } from 'minio';

let cached: MinioClient | null | undefined;

function getClient(): MinioClient | null {
  if (cached !== undefined) return cached;
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  if (!endpoint || !accessKey || !secretKey) {
    cached = null;
    return cached;
  }
  try {
    const url = new URL(endpoint);
    cached = new MinioClient({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      useSSL: url.protocol === 'https:',
      accessKey,
      secretKey,
    });
  } catch {
    cached = null;
  }
  return cached;
}

export function invoicePdfBucket(): string {
  return process.env.S3_BUCKET ?? 'bigbluebam-uploads';
}

/** The storage key the worker writes for an invoice. */
export function invoicePdfKey(invoiceId: string): string {
  return `bill/invoices/${invoiceId}.pdf`;
}

/**
 * A stream of the stored PDF for an invoice, or null when there is no
 * readable stored copy (getObject rejects up front on a missing object).
 * Only the key the worker writes for THIS invoice is read, so a tampered
 * `pdf_url` cannot point the route at another object.
 */
export async function openStoredInvoicePdf(
  invoiceId: string,
  pdfUrl: string | null | undefined,
): Promise<Readable | null> {
  const key = invoicePdfKey(invoiceId);
  if (pdfUrl !== key) return null;
  const client = getClient();
  if (!client) return null;
  try {
    return await client.getObject(invoicePdfBucket(), key);
  } catch {
    return null;
  }
}

/** Test hook: forget the cached client so env changes take effect. */
export function __resetInvoicePdfStorageForTests(): void {
  cached = undefined;
}
