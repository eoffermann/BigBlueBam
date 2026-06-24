import { z } from 'zod';
import type { StorageDriverKind } from './driver.js';

/** Non-secret provider config, validated per driver kind (Bin master §5.1). */
export const s3ConfigSchema = z.object({
  endpoint: z.string().url(),
  region: z.string().default('us-east-1'),
  bucket: z.string().min(1),
  /** Optional key prefix all objects live under. */
  basePath: z.string().optional(),
});
export type S3Config = z.infer<typeof s3ConfigSchema>;

// Bundled MinIO / on-disk default uses the same S3-shaped config.
export const localConfigSchema = s3ConfigSchema;

export const rcloneConfigSchema = z.object({
  /** rclone backend type, e.g. 'drive', 'dropbox', 'onedrive'. */
  remoteType: z.string().min(1),
  /** Named remote configured in the worker's rclone config. */
  remoteName: z.string().min(1),
  basePath: z.string().optional(),
});
export type RcloneConfig = z.infer<typeof rcloneConfigSchema>;

/** Validate a provider row's `config` JSON against its kind. Throws (ZodError)
 *  on invalid config so a bad provider is rejected at create/bind time. */
export function parseProviderConfig(kind: StorageDriverKind, config: unknown) {
  switch (kind) {
    case 's3':
      return { kind, config: s3ConfigSchema.parse(config) } as const;
    case 'local':
      return { kind, config: localConfigSchema.parse(config) } as const;
    case 'rclone':
      return { kind, config: rcloneConfigSchema.parse(config) } as const;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown driver kind: ${_exhaustive as string}`);
    }
  }
}

/** Secret bundle decrypted by the secrets service and injected into a driver. */
export interface ProviderSecret {
  accessKey: string;
  secretKey: string;
}
