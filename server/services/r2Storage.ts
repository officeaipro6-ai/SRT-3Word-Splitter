/**
 * Cloudflare R2 Storage Provider implementing the StorageProvider interface.
 *
 * Uses S3-compatible API via @aws-sdk/client-s3. Implements the same
 * interface as LocalFileStorageProvider for seamless swap.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageProvider } from './storage';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function validateR2Config(config: R2Config): void {
  if (!config.accountId) throw new Error('R2_ACCOUNT_ID is required');
  if (!config.accessKeyId) throw new Error('R2_ACCESS_KEY_ID is required');
  if (!config.secretAccessKey) throw new Error('R2_SECRET_ACCESS_KEY is required');
  if (!config.bucket) throw new Error('R2_BUCKET is required');
}

function createR2Client(config: R2Config): S3Client {
  validateR2Config(config);
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  } satisfies S3ClientConfig);
}

export class R2StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    this.client = createR2Client(config);
    this.bucket = config.bucket;
  }

  private getKey(key: string): string {
    // Keys are already sanitized by callers via resolveKey
    // R2 keys must not start with /
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
      // Convert Readable stream to Buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
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
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
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

  /**
   * Generate a presigned URL for direct browser uploads.
   * Optional: for future use if needed.
   */
  async getPresignedUploadUrl(key: string, expiresIn = 3600): Promise<string> {
    const objectKey = this.getKey(key);
    return getSignedUrl(this.client, new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    }), { expiresIn });
  }

  /**
   * Generate a presigned URL for downloads.
   * Optional: for future use if needed.
   */
  async getPresignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    const objectKey = this.getKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    }), { expiresIn });
  }
}

/**
 * Factory function to create the appropriate storage provider based on config.
 */
export function createStorageProvider(
  type: 'local' | 'r2',
  config: { root?: string; r2Config?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string } }
): StorageProvider {
  if (type === 'r2') {
    if (!config.r2Config) {
      throw new Error('R2 configuration required for R2 storage provider');
    }
    return new R2StorageProvider(config.r2Config);
  }
  // Default to local
  const root = config.root ?? process.cwd();
  const { LocalFileStorageProvider } = require('./storage');
  return new LocalFileStorageProvider(root);
}

export { StorageProvider } from './storage';