/**
 * Backblaze B2 Storage Provider — the production object store.
 *
 * Replaces Cloudflare R2 as the production backend. B2 exposes an
 * S3-compatible API, so this uses the same `@aws-sdk/client-s3` client and the
 * same four commands the previous R2 provider used: PutObject, GetObject,
 * HeadObject, DeleteObject.
 *
 * Design constraints (deliberately unchanged from the R2 provider):
 *  - The StorageProvider interface is untouched: put / get / exists / delete.
 *  - Object keys are passed through verbatim apart from stripping a single
 *    leading "/", so every key the application already writes
 *    ("uploads/<jobId>.<ext>", "srt/<sha256>-<lang>.srt") resolves to exactly
 *    the same object it did under R2. No prefixing, no renaming, no hashing.
 *  - There is no list() operation, by design.
 *  - Secrets are read from the environment only. No key ID or application key
 *    is ever embedded here, echoed in an error, or logged.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { StorageProvider } from './storage';

/** Everything needed to talk to a B2 bucket over the S3-compatible API. */
export interface B2Config {
  /** S3-compatible endpoint, e.g. https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  /** B2 region, e.g. us-west-004 */
  region: string;
  bucket: string;
  /** B2 key ID — secret, environment only. */
  keyId: string;
  /** B2 application key — secret, environment only. */
  applicationKey: string;
}

/**
 * The environment variable that supplies each field. Used to report *which*
 * variable is missing without ever reading, quoting or logging its value.
 */
export const B2_ENV_KEYS = {
  endpoint: 'B2_ENDPOINT',
  region: 'B2_REGION',
  bucket: 'B2_BUCKET',
  keyId: 'B2_KEY_ID',
  applicationKey: 'B2_APPLICATION_KEY',
} as const;

/** Names of the B2 environment variables that are absent or blank, in order. */
export function missingB2EnvKeys(env: Record<string, string | undefined> = process.env): string[] {
  return Object.values(B2_ENV_KEYS).filter((name) => !(env[name] ?? '').trim());
}

/**
 * A configuration error that names the missing VARIABLES only. Credential
 * values never reach this string, so it is safe to log or surface.
 */
export function b2ConfigurationError(missing: string[]): Error {
  return new Error(
    `B2 configuration required: ${missing.join(', ')} ` +
      `must be set when STORAGE_PROVIDER=b2. Credentials are supplied through ` +
      `environment variables only and are never logged. There is no silent ` +
      `fallback to local storage.`
  );
}

/** Reject an incomplete config before any client is constructed. */
export function validateB2Config(config: B2Config): void {
  if (!config.endpoint) throw new Error(`${B2_ENV_KEYS.endpoint} is required`);
  if (!config.region) throw new Error(`${B2_ENV_KEYS.region} is required`);
  if (!config.bucket) throw new Error(`${B2_ENV_KEYS.bucket} is required`);
  if (!config.keyId) throw new Error(`${B2_ENV_KEYS.keyId} is required`);
  if (!config.applicationKey) throw new Error(`${B2_ENV_KEYS.applicationKey} is required`);
}

/**
 * Build the S3 client for B2.
 *
 * `forcePathStyle` keeps requests in path form (/<bucket>/<key>) rather than
 * virtual-host form. B2 accepts both, but path style is the safe choice for a
 * custom S3-compatible endpoint: it avoids TLS/SNI problems if a bucket name
 * ever contains dots, and it keeps the wire format predictable.
 */
export function createB2Client(config: B2Config): S3Client {
  validateB2Config(config);
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.keyId,
      secretAccessKey: config.applicationKey,
    },
    forcePathStyle: true,
  } satisfies S3ClientConfig);
}

export class B2StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: B2Config) {
    this.client = createB2Client(config);
    this.bucket = config.bucket;
  }

  /** The bucket this provider writes to. Exposed for tests/diagnostics only. */
  get bucketName(): string {
    return this.bucket;
  }

  private getKey(key: string): string {
    // Keys are already sanitized by callers via resolveKey.
    // Object keys must not start with /.
    return key.startsWith('/') ? key.slice(1) : key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const objectKey = this.getKey(key);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      Body: data,
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const objectKey = this.getKey(key);
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }));
      if (!response.Body) return null;
      // Convert the readable stream to a Buffer, exactly as before.
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error: any) {
      if (error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const objectKey = this.getKey(key);
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }));
      return true;
    } catch (error: any) {
      if (error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const objectKey = this.getKey(key);
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    })).catch(() => undefined);
  }
}

/** Factory: construct the B2 provider from an already-validated config. */
export function createB2StorageProvider(config: B2Config): B2StorageProvider {
  return new B2StorageProvider(config);
}

export type { StorageProvider } from './storage';