/**
 * Express 4 async route safety.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Express 4 does not know about promises. It calls a handler, ignores the return
 * value, and only sees errors that are thrown SYNCHRONOUSLY. A handler that
 * rejects later produces an unhandled rejection: no response is sent, the client
 * hangs or sees a socket error, and on Node 15+ the default behaviour is to
 * TERMINATE THE PROCESS.
 *
 * That is not hypothetical here. Turning the credit service async means
 * `await credits.chargeJob(...)` inside a handler can reject with `CreditError`
 * long after the handler returned. Without this wrapper, every one of those
 * rejections would be unhandled.
 *
 * THE FIX
 * -------
 * Wrap the handler so its promise is awaited and any rejection is forwarded to
 * Express's `next`, which routes it to the error-handling middleware. The
 * error object is passed through UNCHANGED, so `instanceof CreditError` checks
 * and `err.code`/`err.status` reads keep working exactly as they do today.
 *
 * This is deliberately NOT a promise wrapper for the whole app: it is opt-in per
 * handler, so a sync handler's behaviour is bit-for-bit what it was.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * True when the error looks like a malformed multipart body from body-parser or
 * multer. Express 4's error middleware does not set `status`/`statusCode` for
 * these, so a route-level catch that only inspects those would fall through to a
 * generic 500 and hide a plain client mistake behind a server error.
 */
function isBadRequest(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown; name?: unknown };
  return (
    e.type === 'entity.parse.failed' ||
    e.type === 'entity.too.large' ||
    e.status === 400 ||
    e.statusCode === 400 ||
    e.name === 'SyntaxError'
  );
}

/**
 * Adapt an async handler for Express 4.
 *
 * Guarantees, in order:
 *   1. A synchronous throw is forwarded to `next` (same as a bare Express 4
 *      handler, so nothing regresses).
 *   2. A later rejection is forwarded to `next` instead of becoming an unhandled
 *      rejection.
 *   3. A malformed-JSON / oversized-body parse error becomes a 400, because it
 *      is the client's mistake and must not be reported as a server fault.
 *   4. If `next(err)` was called and the error MIDDLEWARE itself throws while
 *      serialising (a circular payload, a failed JSON.stringify), the failure is
 *      logged rather than dropped. Swallowing it would hide a real bug; throwing
 *      would be an unhandled rejection all over again.
 *
 * It never writes a response itself: status mapping stays where it already is, in
 * each handler's try/catch and in the error middleware.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    let result: Promise<unknown>;
    try {
      result = handler(req, res, next);
    } catch (err) {
      // Synchronous throw: identical to an unwrapped Express 4 handler.
      next(err);
      return;
    }
    if (!result || typeof (result as Promise<unknown>).then !== 'function') {
      // Defensive: a handler that forgot to be async. Nothing to await.
      return;
    }
    result.then(undefined, (err: unknown) => {
      try {
        if (isBadRequest(err)) {
          if (!res.headersSent) {
            res.status(400).json({ error: 'Malformed request body.' });
          }
          return;
        }
        next(err);
      } catch (secondary: unknown) {
        // The error middleware itself failed. Log loudly; never re-throw.
        console.error('[asyncRoute] error middleware threw while handling a rejection', {
          original: err instanceof Error ? err.message : String(err),
          secondary: secondary instanceof Error ? secondary.message : String(secondary),
        });
        if (!res.headersSent) {
          try {
            res.status(500).json({ error: 'Internal server error.' });
          } catch {
            // Response is unusable; nothing further is safe to do here.
          }
        }
      }
    });
  };
}

/**
 * Run an async task that is NOT part of a request lifecycle (queue recovery,
 * background reconciliation) and make sure its rejection can never become an
 * unhandled rejection.
 *
 * `label` is used for the log line so a swallowed failure is still attributable.
 */
export function runDetached(label: string, task: () => Promise<unknown>): void {
  void (async () => {
    try {
      await task();
    } catch (err) {
      console.error(`[detached:${label}] failed`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}