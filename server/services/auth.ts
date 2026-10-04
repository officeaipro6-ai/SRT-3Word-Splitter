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

/**
 * Decide whether a session request may keep the bearer token it presented.
 *
 * `/api/session` used to mint a NEW token on every call, so each browser refresh
 * appended another hash to `users.tokenHashes` and that array grew without bound
 * (one entry per refresh, none of them ever removable except by an explicit
 * logout of that exact token).
 *
 * A presented token that is well-formed AND already resolves to a live user is
 * by definition still valid, so the server hands the SAME token back rather than
 * recording a second hash for what is really one session. This keeps growth
 * proportional to genuine new sign-ins instead of to page loads, and it never
 * invalidates a token that was valid a moment ago.
 *
 * Returns null when a fresh token must be minted: nothing was presented, the
 * token is malformed, or the server cannot resolve it (unknown/revoked).
 */
export function selectSessionToken(presented: string | null, presentedResolvesToUser: boolean): string | null {
  if (presented && isValidTokenShape(presented) && presentedResolvesToUser) return presented;
  return null;
}