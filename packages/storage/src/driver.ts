// Storage driver abstraction (Bin master §4). One driver instance per
// storage_providers row; the factory injects already-decrypted credentials.

export type StorageDriverKind = 's3' | 'rclone' | 'local';

/** Static description of what a driver instance can do. Bin uses these flags to
 *  decide which roles a provider may be bound to and which backup strategies are
 *  available. */
export interface StorageCapabilities {
  supportsPresignedGet: boolean;
  supportsPresignedPut: boolean;
  supportsMultipart: boolean;
  supportsServerSideCopy: boolean;
  supportsVersioning: boolean;
  integrityToken: 'etag' | 'crc32c' | 'md5' | 'none';
  canServeHotMedia: boolean;
}

export interface PutResult {
  key: string;
  size: number;
  integrity: string;
}

export interface ObjectStat {
  key: string;
  size: number;
  integrity: string;
  modifiedAt: Date;
}

export interface StorageDriver {
  readonly kind: StorageDriverKind;
  readonly capabilities: StorageCapabilities;

  /** Validate credentials + reachability. */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;

  put(
    key: string,
    body: NodeJS.ReadableStream | Buffer,
    opts?: { contentType?: string; size?: number },
  ): Promise<PutResult>;
  getStream(key: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number }>;
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;

  presignGet?(key: string, ttlSeconds: number): Promise<string>;
  presignPut?(key: string, ttlSeconds: number, opts?: { contentType?: string }): Promise<string>;

  list(prefix: string, cursor?: string): Promise<{ objects: ObjectStat[]; cursor?: string }>;

  copyTo?(destKey: string, sourceKey: string): Promise<void>;
}
