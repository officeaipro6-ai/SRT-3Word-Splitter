/**
 * FIFO write serialization for libSQL/SQLite-backed stores.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@libsql/client`'s `client.transaction('write')` internally sets its private
 * `#db = null` and starts the transaction on a BRAND NEW connection. That
 * connection carries SQLite's default `busy_timeout = 0`, and the driver exposes
 * no way to change it for a transaction connection (a `PRAGMA busy_timeout` on
 * the pool does not apply — it is a different connection).
 *
 * The consequence is that two overlapping write transactions do not queue: the
 * loser fails IMMEDIATELY with `SQLITE_BUSY`. For a payment webhook that is the
 * worst possible outcome — the gateway considers the payment taken while the app
 * records no purchase and no ledger row. It is also a *silent* failure mode,
 * because `SQLITE_BUSY` looks like an ordinary transient error.
 *
 * THE FIX
 * -------
 * Serialize write transactions in-process, in FIFO order, so a second writer
 * WAITS for the first to commit instead of colliding. Nothing is retried and
 * nothing is swallowed: the wait is bounded, and a caller that cannot get the
 * lock in time fails loudly.
 *
 * DELIBERATE NON-GOALS
 * --------------------
 *   - Reads are NOT serialized. Read paths use the connection pool directly and
 *     are never routed through this queue, so write safety costs no read
 *     latency. SQLite's WAL mode gives readers a consistent snapshot during a
 *     write anyway.
 *   - This is a correctness/liveness aid, not a throughput optimisation. It
 *     assumes ONE store instance per database. Two instances pointed at the same
 *     file would still race, and against a shared cloud database the server may
 *     also contend with OTHER app instances — which is exactly why the
 *     deployment smoke test re-verifies the UNIQUE-index conflict path.
 */

/** Thrown when a write cannot obtain the lock inside its budget. */
export class WriteLockTimeoutError extends Error {
  readonly code = 'WRITE_LOCK_TIMEOUT';
  readonly timeoutMs: number;
  readonly queueDepth: number;

  constructor(timeoutMs: number, queueDepth: number) {
    super(
      `Write serialization: no slot within ${timeoutMs}ms (${queueDepth} writer(s) queued). ` +
        'This operation did NOT run and nothing was committed.',
    );
    this.name = 'WriteLockTimeoutError';
    this.timeoutMs = timeoutMs;
    this.queueDepth = queueDepth;
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WriteMutex {
  /** True while a writer holds the lock. */
  private locked = false;
  /** Live waiters, oldest first. FIFO is what prevents writer starvation. */
  private readonly waiters: Waiter[] = [];

  constructor(
    /**
     * How long a writer may wait for its slot before failing loudly. Chosen to
     * sit below the shortest sensible client/gateway timeout, because a credit
     * write that commits long after the caller gave up is worse than a fast,
     * visible failure.
     */
    private readonly timeoutMs: number = 15_000,
  ) {}

  /** Number of writers waiting for a slot (excludes the one in flight). */
  get queueDepth(): number {
    return this.waiters.length;
  }

  /** True while a writer is inside the critical section. */
  get isHeld(): boolean {
    return this.locked;
  }

  /**
   * Run `fn` with exclusive write access, in FIFO arrival order.
   *
   * `fn` is expected to manage its own commit/rollback. This class guarantees
   * ONLY mutual exclusion and ordering; rollback semantics deliberately stay
   * with the caller so they cannot be bypassed here.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked && this.waiters.length === 0) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null as unknown as ReturnType<typeof setTimeout> };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new WriteLockTimeoutError(this.timeoutMs, this.waiters.length));
      }, this.timeoutMs);
      // Never hold the event loop open merely to time out a writer.
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  /** Pass the lock to the next waiter (stay locked), or clear it. */
  private release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.locked = false;
      return;
    }
    clearTimeout(next.timer);
    next.resolve();
  }
}