/**
 * Minimal structured JSON logger (one object per line => easy ingestion).
 *
 * Security rules:
 *   - NEVER log API keys, bearer tokens, transcripts, or raw file contents.
 *   - Only allow known safe fields via the free-form `fields` object.
 *   - Log callers must explicitly include a value; there is no auto-serialize
 *     of arbitrary objects that could leak secrets.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const v = (process.env.LOG_LEVEL || 'info').trim().toLowerCase() as LogLevel;
  return LEVEL_ORDER[v] ?? LEVEL_ORDER.info;
}

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  // Errors go to stderr; the rest to stdout. Both are structured JSON lines.
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const nestedLog = {
  debug: (msg: string, fields?: Record<string, unknown>) => log('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, fields),
};

/** Redact anything that looks like a secret for user-facing error surfaces. */
export function redact(value: string): string {
  const keyLike = /([A-Za-z0-9_\-]{0,20}(KEY|TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_\-]{0,20})/gi;
  const urlLike = /(https?:\/\/[^\s]+)/gi;
  return String(value).replace(keyLike, '[REDACTED]').replace(urlLike, '[REDACTED]');
}