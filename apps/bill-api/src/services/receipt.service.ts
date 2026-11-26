/**
 * Receipt upload service for bill expenses.
 *
 * Uploads receipt files to MinIO under bill/receipts/<expense-id>.<ext>
 * and updates the expense row with the receipt URL and metadata.
 */

import { Client as MinioClient } from 'minio';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { billExpenses } from '../db/schema/index.js';
import { env } from '../env.js';
import path from 'node:path';

// ---------------------------------------------------------------------------
// MinIO client singleton
// ---------------------------------------------------------------------------

let _minio: MinioClient | null = null;

function getMinio(): MinioClient {
  if (!_minio) {
    const endpoint = env.MINIO_ENDPOINT;
    const [host, portStr] = endpoint.split(':');
    _minio = new MinioClient({
      endPoint: host!,
      port: portStr ? Number.parseInt(portStr, 10) : 9000,
      useSSL: false,
      accessKey: env.MINIO_ACCESS_KEY ?? 'minioadmin',
      secretKey: env.MINIO_SECRET_KEY ?? 'minioadmin',
    });
  }
  return _minio;
}

const BUCKET = 'bigbluebam';
const RECEIPT_PREFIX = 'bill/receipts';

// Allowed receipt file extensions and their MIME types
const ALLOWED_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badRequest(msg: string): Error {
  const err = new Error(msg) as Error & { statusCode: number; code: string };
  err.statusCode = 400;
  err.code = 'BAD_REQUEST';
  err.name = 'BillError';
  return err;
}

function notFound(msg: string): Error {
  const err = new Error(msg) as Error & { statusCode: number; code: string };
  err.statusCode = 404;
  err.code = 'NOT_FOUND';
  err.name = 'BillError';
  return err;
}

// ---------------------------------------------------------------------------
// Upload receipt
// ---------------------------------------------------------------------------

export async function uploadReceipt(
  expenseId: string,
  orgId: string,
  file: {
    filename: string;
    mimetype: string;
    file: NodeJS.ReadableStream;
  },
): Promise<{
  receipt_url: string;
  receipt_filename: string;
  receipt_mime_type: string;
  receipt_size_bytes: number;
}> {
  // 1. Verify the expense exists and belongs to this org
  const [expense] = await db
    .select({ id: billExpenses.id })
    .from(billExpenses)
    .where(
      and(
        eq(billExpenses.id, expenseId),
        eq(billExpenses.organization_id, orgId),
      ),
    )
    .limit(1);

  if (!expense) throw notFound('Expense not found');

  // 2. Validate file extension
  const ext = path.extname(file.filename).toLowerCase();
  if (!ALLOWED_TYPES[ext]) {
    throw badRequest(
      `Unsupported file type: ${ext}. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}`,
    );
  }

  // 3. Read file into buffer (with size limit)
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of file.file) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array);
    totalSize += buf.length;
    if (totalSize > MAX_FILE_SIZE) {
      throw badRequest(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024} MB`);
    }
    chunks.push(buf);
  }

  const buffer = Buffer.concat(chunks);

  // 4. Upload to MinIO
  const objectName = `${RECEIPT_PREFIX}/${expenseId}${ext}`;
  const minio = getMinio();

  // Ensure bucket exists
  const bucketExists = await minio.bucketExists(BUCKET);
  if (!bucketExists) {
    await minio.makeBucket(BUCKET);
  }

  await minio.putObject(BUCKET, objectName, buffer, buffer.length, {
    'Content-Type': ALLOWED_TYPES[ext]!,
  });

  // 5. Build the public URL
  const receiptUrl = `/files/${objectName}`;

  // 6. Update the expense row
  await db
    .update(billExpenses)
    .set({
      receipt_url: receiptUrl,
      receipt_filename: file.filename,
      receipt_mime_type: ALLOWED_TYPES[ext],
      receipt_size_bytes: buffer.length,
      receipt_uploaded_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(billExpenses.id, expenseId));

  return {
    receipt_url: receiptUrl,
    receipt_filename: file.filename,
    receipt_mime_type: ALLOWED_TYPES[ext]!,
    receipt_size_bytes: buffer.length,
  };
}
