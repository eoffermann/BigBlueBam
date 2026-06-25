import * as Minio from 'minio';
import type { Readable } from 'node:stream';
import type {
  ObjectStat,
  PutResult,
  StorageCapabilities,
  StorageDriver,
  StorageDriverKind,
} from './driver.js';

export interface S3DriverOptions {
  kind: 's3' | 'local';
  endpoint: string;
  region: string;
  bucket: string;
  basePath?: string;
  accessKey: string;
  secretKey: string;
}

const LIST_PAGE = 1000;

/** MinIO-backed driver covering any S3-compatible endpoint and the bundled local
 *  MinIO. Consolidates the three ad-hoc clients (AB-2). */
export class S3Driver implements StorageDriver {
  readonly kind: StorageDriverKind;
  readonly capabilities: StorageCapabilities = {
    supportsPresignedGet: true,
    supportsPresignedPut: true,
    supportsMultipart: true,
    supportsServerSideCopy: true,
    supportsVersioning: false,
    integrityToken: 'etag',
    canServeHotMedia: true,
  };

  private readonly client: Minio.Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly basePath: string;
  private ensured = false;

  constructor(opts: S3DriverOptions) {
    this.kind = opts.kind;
    this.bucket = opts.bucket;
    this.region = opts.region;
    this.basePath = opts.basePath?.replace(/\/+$/, '') ?? '';
    const url = new URL(opts.endpoint);
    this.client = new Minio.Client({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 9000),
      useSSL: url.protocol === 'https:',
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      region: opts.region,
    });
  }

  private k(key: string): string {
    return this.basePath ? `${this.basePath}/${key}` : key;
  }

  private async ensureBucket(): Promise<void> {
    if (this.ensured) return;
    if (!(await this.client.bucketExists(this.bucket))) {
      await this.client.makeBucket(this.bucket, this.region);
    }
    this.ensured = true;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const start = Date.now();
    try {
      await this.client.bucketExists(this.bucket);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, detail: (err as Error).message };
    }
  }

  async put(
    key: string,
    body: NodeJS.ReadableStream | Buffer,
    opts?: { contentType?: string; size?: number },
  ): Promise<PutResult> {
    await this.ensureBucket();
    const meta = opts?.contentType ? { 'Content-Type': opts.contentType } : undefined;
    const size = opts?.size ?? (Buffer.isBuffer(body) ? body.length : undefined);
    // minio types want a node Readable | Buffer; a NodeJS.ReadableStream at
    // runtime is a Readable, so narrow for the type checker.
    const payload = body as Buffer | Readable;
    const res = await this.client.putObject(this.bucket, this.k(key), payload, size, meta);
    const stat = await this.stat(key);
    return { key, size: stat?.size ?? size ?? 0, integrity: res.etag };
  }

  async getStream(
    key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number }> {
    const s = await this.client.statObject(this.bucket, this.k(key));
    const stream = await this.client.getObject(this.bucket, this.k(key));
    return {
      stream,
      contentType: s.metaData?.['content-type'] ?? 'application/octet-stream',
      size: s.size,
    };
  }

  async getRange(
    key: string,
    start: number,
    end: number,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number; total: number }> {
    const s = await this.client.statObject(this.bucket, this.k(key));
    const length = end - start + 1;
    // MinIO getPartialObject(bucket, key, offset, length) → a stream of [offset, offset+length).
    const stream = await this.client.getPartialObject(this.bucket, this.k(key), start, length);
    return {
      stream,
      contentType: s.metaData?.['content-type'] ?? 'application/octet-stream',
      size: length,
      total: s.size,
    };
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const s = await this.client.statObject(this.bucket, this.k(key));
      return { key, size: s.size, integrity: s.etag, modifiedAt: s.lastModified };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, this.k(key));
  }

  presignGet(key: string, ttlSeconds: number): Promise<string> {
    return this.client.presignedGetObject(this.bucket, this.k(key), ttlSeconds);
  }

  presignPut(key: string, ttlSeconds: number): Promise<string> {
    return this.client.presignedPutObject(this.bucket, this.k(key), ttlSeconds);
  }

  list(prefix: string, cursor?: string): Promise<{ objects: ObjectStat[]; cursor?: string }> {
    return new Promise((resolve, reject) => {
      const objects: ObjectStat[] = [];
      const fullPrefix = this.k(prefix);
      const stripLen = this.basePath ? this.basePath.length + 1 : 0;
      const stream = this.client.listObjectsV2(this.bucket, fullPrefix, true, cursor);
      stream.on('data', (obj) => {
        if (objects.length >= LIST_PAGE) return;
        if (!obj.name) return;
        objects.push({
          key: stripLen ? obj.name.slice(stripLen) : obj.name,
          size: obj.size ?? 0,
          integrity: obj.etag ?? '',
          modifiedAt: obj.lastModified ?? new Date(0),
        });
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const more = objects.length >= LIST_PAGE;
        resolve({ objects, cursor: more ? objects[objects.length - 1]!.key : undefined });
      });
    });
  }

  async copyTo(destKey: string, sourceKey: string): Promise<void> {
    await this.ensureBucket();
    const conds = new Minio.CopyConditions();
    await this.client.copyObject(this.bucket, this.k(destKey), `/${this.bucket}/${this.k(sourceKey)}`, conds);
  }
}
