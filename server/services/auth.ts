/**
 * Session auth — opaque bearer tokens issued by the server, stored ONLY as
 * sha256 hashes. This gives each request a stable, server-verified user
 * identity so jobs/credits/SRTs can be ownership-checked for multi-user safety,
 * without introducing passwords, OAuth, or new dependencies.
 */
import { createHash, randomBytes } from 'crypto';
import type { Request } from 'express';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Extract a bearer token from Authorization or x-user-token header. */
export function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim() || null;
  }
  const raw = req.headers['x-user-token'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return null;
}

/** A token is considered present and well-formed (non-empty). */
export function isValidTokenShape(token: string | null): token is string {
  return Boolean(token && token.length >= 16 && token.length <= 256);
}