/**
 * Password hashing for the normal email/password USER account layer.
 *
 * Uses Node's built-in `crypto.scrypt` (no new dependency). The stored value is
 * a self-describing `scrypt$<saltBase64>$<hashBase64>` string — never the
 * plaintext. `crypto.timingSafeEqual` makes the comparison timing-safe.
 *
 * Keep ADMIN authentication fully separate: this module is used ONLY by the
 * account signup/login path, never by the owner bootstrap secret.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

const SCRYPT_KEY_LEN = 64;
const PREFIX = 'scrypt$';

/** Hash a plaintext password into a self-describing string. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEY_LEN);
  return `${PREFIX}${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verify a plaintext password against a stored hash (safe against bad input). */
export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== PREFIX.slice(0, -1)) return false;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = scryptSync(password, salt, expected.length || SCRYPT_KEY_LEN);
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Length policy used by signup validation. */
export function isPasswordLengthValid(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH
  );
}