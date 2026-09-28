/**
 * StorageProvider abstraction — local filesystem today, cloud object storage
 * later (the interface is the seam). Keys are logical ("uploads/<jobId>.wav",
 * "srt/<jobId>.srt"); path resolution + traversal protection live here.
 */
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { extForMimeType } from '../config';

export interface StorageProvider {
  /** Persist bytes at a logical key (atomic write). */
  put(key: string, data: Buffer): Promise<void>;
  /** Fetch bytes, or null when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** Sanitize a logical key into a safe relative path under `root`. */
function resolveKey(root: string, key: string): string {
  const parts = String(key)
    .split(/[\\/]/)
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) throw new Error('Invalid storage key');
  const resolved = path.resolve(root, ...parts);
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(rootResolved + path.sep)) {
    throw new Error('Storage key escapes root');
  }
  return resolved;
}

export class LocalFileStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private abs(key: string): string {
    return resolveKey(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const abs = this.abs(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, data);
    try {
      await fsp.rename(tmp, abs);
    } catch {
      await new Promise((r) => setTimeout(r, 50));
      try {
        await fsp.rename(tmp, abs);
      } catch {
        await fsp.writeFile(abs, data);
        await fsp.unlink(tmp).catch(() => undefined);
      }
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fsp.readFile(this.abs(key));
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.abs(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fsp.unlink(this.abs(key)).catch(() => undefined);
  }
}

/** Logical key helpers (also used by the queue worker). */
export function uploadKey(jobId: string, mimeType: string): string {
  return `uploads/${jobId}.${extForMimeType(mimeType)}`;
}

export function srtKey(jobId: string): string {
  return `srt/${jobId}.srt`;
}

export function safeOriginalName(name: string): string {
  const base = path.basename(String(name || 'audio').replace(/[^\w.\- ]/g, '_'));
  return base || 'audio';
}

/** Conservative extension for a community attachment, from its MIME type. */
export function extensionForMime(mime: string): string {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/png') return '.png';
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/webp') return '.webp';
  if (m === 'video/mp4') return '.mp4';
  if (m === 'video/webm') return '.webm';
  if (m === 'audio/mpeg' || m === 'audio/mp3') return '.mp3';
  if (m === 'audio/wav' || m === 'audio/x-wav') return '.wav';
  if (m === 'audio/webm') return '.weba';
  if (m === 'audio/ogg') return '.ogg';
  // Never trust the client filename for the stored extension.
  return '';
}