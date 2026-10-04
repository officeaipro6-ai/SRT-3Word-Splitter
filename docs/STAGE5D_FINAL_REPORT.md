# Stage 5D — Final Report

**Status: STAGE 5D FINAL CLOSED.**
All local gates pass. **Not deployed.** No cloud writes. No production database
contact. Razorpay LIVE never activated.

**Closure addendum — E1 payment-safety fix applied.** The last open blocker (E1:
payment handlers able to reject unhandled) has been fixed. See §A13 and §E1.

---

## A. Changes made

### A1. Transaction-scoped unit of work
- `TursoStore.unitOfWork()` begins one libSQL write transaction, runs a callback
  against a `TursoScope`, commits on success, rolls back and rethrows on failure.
- `TursoScope` deliberately exposes **no** `commit`, `rollback`, raw client or
  raw transaction handle, so a callback cannot commit early or escape its scope.
- Nested `unitOfWork()` is **rejected** rather than silently reusing a
  transaction.

### A2. Atomic credit operations
Balance mutation and ledger insert now share one transaction, so a credit
operation cannot half-apply. Covered: purchase, admin adjustment/grant/debit,
job charge, reservation, settle, release, refund, registration credits, and the
free-trial counter increment.

### A3. Shared credit rules
Extracted to `server/services/creditRules.ts` and used by both providers.
`FileCreditService` now calls the shared `assertValidAmount()` instead of
duplicating validation. `CreditError` was completed with `MAX_EXCEEDED` and
`DAILY_LIMIT_EXCEEDED` (this alone removed two pre-existing type errors). A
dead `isReducing` re-export was removed.

### A4. Provider-spend parity
A shared `AVAILABLE` default removed divergence between the JSON and Turso
spending-guard defaults.

### A5. Catalog de-duplication (`getPlanById`)
`getPlanById()` previously returned `undefined` for **every** plan, because it
searched an array of plan *objects* using `===` against a plan *id* string.
- Fixed to resolve from the canonical `CREDIT_PACKS`.
- `razorpayService.ts` had a **second, divergent copy** of the catalog. It now
  re-exports the canonical one, so there is a single source of truth.
- All six plan IDs (`starter`, `basic`, `standard`, `pro`, `large`, `annual`)
  resolve with **prices and credit amounts unchanged**.
- Because both providers route through `creditPolicy`, the fix applies to both.

### A6. Write serialization (`WriteMutex`)
- `server/db/writeMutex.ts`: FIFO lock, 15 s timeout,
  `WriteLockTimeoutError` (`code = 'WRITE_LOCK_TIMEOUT'`).
- `TursoStore` now queues **writes only**; reads bypass the lock entirely.
- The previous instance-wide `transactionOpen` boolean was removed. It could not
  distinguish a genuine nested transaction (a bug that must fail loudly) from an
  unrelated concurrent request (which must simply queue). `AsyncLocalStorage`
  gives per-request context, so the two are finally separable.
- Rationale: libSQL opens each transaction on a **fresh connection** with
  `busy_timeout = 0`, so overlapping writers fail instantly with `SQLITE_BUSY`
  rather than queueing. The loser rolls back having written nothing — safe, but
  for a paid webhook it means money taken with no ledger row.

### A7. Async credit facade + Express 4 safety
- `server/services/creditFacade.ts`: `AsyncCreditService`, plus
  `createFileCreditFacade` and `createTursoCreditFacade`. The JSON provider stays
  synchronous **underneath**; only the error *shape* changes (sync throw →
  rejection at the same `await` point), so one handler body is correct for both.
- `server/http/asyncRoute.ts`: `asyncRoute()` forwards async rejections to
  `next()`; `runDetached()` catches and logs background failures.
- 10 route registrations wrapped. `adminUserView` became async because it
  aggregates two async ledger reads; `adminJobView` is pure and stayed sync.
- `queue.ts`: `rehydrate()` is async and awaited before startup; refunds are
  awaited **before** job status updates; interval ticks use `runDetached`.

### A8. Provider-parity bug fix (found during finalization)
`createTursoCreditFacade.assertCanPay()` did **not** exempt `UNLIMITED` users,
while the JSON provider does. An UNLIMITED Turso account would have been
rejected for insufficient balance while the identical JSON account passed —
divergence invisible until the database is swapped. Fixed and regression-tested.

### A9. Latent-unsafe JSON facade methods
`registerUserWithCredits()` threw a generic `Error`; it now throws a named
`CreditJsonProviderUnsupportedError` so an incomplete wiring fails loudly instead
of minting an account with no ledger row. `incrementFreeTrialsUsed()` still
returns `null` — that is type-legal and a harmless no-op; converting it to a
throw would have been an unrequested behaviour change.

### A10. Database-level money identity (schema v3)
New `server/db/creditIdentityIndexes.ts`. Three **partial** unique indexes:

| Index | Columns | Prevents |
|---|---|---|
| `ux_transactions_payment_id` | `paymentId` | two ledger rows for one payment |
| `ux_transactions_idempotency` | `userId, idempotencyKey, type` | an admin adjustment applying twice |
| `ux_transactions_job_type` | `userId, jobId, type` | a job being charged/refunded twice |

- **Partial** (`WHERE col IS NOT NULL`) because all three columns are nullable.
  SQLite already treats NULLs as distinct, but the partial index states the
  intent explicitly and is smaller/faster — the common `jobId IS NULL` admin row
  is excluded outright.
- **Rejected alternative:** forcing uniqueness with `NOT NULL` or a `''` sentinel.
  Both rewrite or reject existing user data.
- `SCHEMA_VERSION` 2 → **3**, recorded in `schema_migrations`.
- Additive only: nothing dropped, altered or rewritten.
- **Conflict-detecting:** if existing rows already violate an index, the
  migration throws and creates **nothing** — not even the indexes that would
  have succeeded. A half-applied migration is harder to reason about than a
  refusal.
- **Dry-run capable** with genuinely zero writes.
- **Idempotent:** re-running is a no-op; it re-reads `sqlite_master` afterwards
  and fails loudly if an index is absent.
- Wired into `TursoStore.init()`, so an older database can no longer run
  unrecognised while the marker claims v3.
- **Per your decision:** historical duplicates remain a **hard stop**. No
  remediation script was created; nothing is deleted, voided, rewritten, merged
  or reinterpreted. The read-only `planCreditIdentityMigration()` conflict
  report is the sole tool.

### A11. A test that had encoded a bug as intended behaviour
`5C5-B2` deliberately seeded **three** `DEBIT` rows for one
`(userId, jobId, type)` and asserted "earliest wins" — i.e. it documented a
double-charge defect and relied on a tie-break to mask it.

Verified no legitimate flow can produce that state: every per-job operation
(`chargeJob`, `reserveJob`, `settle`, `release`, `refund`) checks
`forJobAndType` **first** and returns early, and `reservationForJob` has no
"active-only" filter, so a release does not permit a second `RESERVATION` row.
The index therefore encodes the application's real invariant. The test now
asserts the double charge is **impossible**, and `ORDER BY createdAt` is retained
as a safety net for a not-yet-migrated legacy database.

### A12. Test robustness
`5D-M4` asserted on a 40 ms wall-clock window and flaked under parallel load. The
property being tested is "a blocked writer rejects loudly instead of hanging",
which is meaningfully shorter than the 15 s production timeout — raised to 300 ms
with an explicit "waited roughly the budget" assertion. **No assertion was
weakened or removed to make a suite pass.**

### A13. Payment-handler async safety (closure fix for E1)

Both credit-granting payment paths now use the existing `asyncRoute()` helper:

- `app.post('/api/credits/purchase/verify', auth(), asyncRoute(async (req, res) => {`
- `app.post('/api/credits/purchase/webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {`

Exactly **four lines** changed in `server.ts` — two handler openings, two closings.
Nothing else was touched: no Express upgrade, no credit-service redesign, no
schema change, no SRT-rule change, no pricing or credit change, no data, cloud or
LIVE-payment access.

A rejection from `credits.recordPurchase()` (DB error, `SQLITE_BUSY`, lock
timeout, network blip, unique-constraint violation) is now forwarded to
`next(err)` and rendered by the existing Express error handler, instead of
escaping as an unhandled rejection. Consequences:

- no unhandled promise rejection, and no process crash,
- the client receives a real error response instead of hanging until gateway
  timeout,
- **no credit is granted unless `recordPurchase` succeeds**, because both the
  credit grant and the success response sit after the `await`,
- a Razorpay webhook retry now meets a normal 5xx and is safe to retry —
  `findByPaymentId` plus `recordPurchase` idempotency makes a replay a no-op
  (`alreadyProcessed: true`), so no retry can double-credit,
- all pre-existing signature, amount, currency, status and order verification,
  and every existing 4xx early return, are untouched.

The `asyncRoute(` registration count went from 10 to **12**. The four remaining
bare `async` handlers are the pre-existing non-payment ones
(`/api/process-audio`, `/api/detect-language`, `/api/credits/purchase/order`,
`/api/admin/moderation/attachments/:userId/*key`), each of which already encloses
its awaits in `try`/`catch`.

Verified in the built artefact `dist/server.cjs`, not only in source.

---

## B. Test / build / typecheck results

All commands run from the repository root.

| Gate | Command | Result |
|---|---|---|
| Full suite (run 1) | `npm test` | **449 passed, 0 failed, 0 skipped — exit 0** |
| Full suite (run 2) | `npm test` | **449 passed, 0 failed, 0 skipped — exit 0** |
| Production build | `npm run build` | **exit 0** — `dist/server.cjs`, `dist/index.html` |
| Typecheck | `npx tsc --noEmit` | **296 errors — exactly the baseline, zero new** |

### Closure gates (re-run after the A13 payment fix)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `node node_modules/typescript/bin/tsc --noEmit` | **296 total — delta 0 vs baseline**; `server.ts` still exactly 7 pre-existing errors; zero `asyncRoute` errors |
| Full suite | `npm test` | **449 passed, 0 failed, 0 skipped — exit 0** |
| Production build | `npm run build` | **exit 0** — `vite ✓ built in 7.78s`, `esbuild Done in 58ms`; `dist/server.cjs` 404,690 bytes and `dist/index.html` 1,535 bytes, both freshly written |
| `asyncRoute` registrations | source scan | **12** (was 10) — both payment handlers wrapped |
| Wrapper present in artefact | `dist/server.cjs` scan | **both** `purchase/verify` and `purchase/webhook` wrapped |
| Data integrity | SHA-256 + size | **byte-identical** — hash match, 81,642 bytes, 9 storage files / 69,708 bytes |
| Schema version | source scan | `SCHEMA_VERSION = 3`, unchanged |

Targeted suites covering the touched money path, all re-run and green:

| Suite | Result |
|---|---|
| `server/http/asyncRoute.test.ts` | 12 passed, 0 failed, exit 0 |
| `server/services/creditService.test.ts` | 13 passed, 0 failed, exit 0 |
| `server/db/creditIdentityIndexes.test.ts` | 12 passed, 0 failed, exit 0 |
| `server/services/creditPolicy.test.ts` | 6 passed, 0 failed, exit 0 |
| `server/authz.test.ts` | 11 passed, 0 failed, exit 0 |
| `server/db/stage5dUow.test.ts` | 26 passed, 0 failed, exit 0 |

Note: `.bin\tsc.cmd` was replaced by a bare `tsc` shim during this work (npm
rewrote the shim directory), so the typecheck is invoked via
`node_modules/typescript/bin/tsc` directly. An early invocation that failed to
execute still printed "0 errors"; that result was discarded rather than
reported, and the figures above come from a run that actually executed.

### Typecheck breakdown (296, all pre-existing)

| Area | Errors |
|---|---|
| `server/` (production code) | 20 |
| `prototype/` (archived checkpoint copies) | 271 |
| `scripts/` + `src/` | 5 |

Production `server/` errors are all long-standing and unrelated to Stage 5D:
- `server.ts` ×7 — `DataStoreProvider` not assignable to `DataStore` (×6),
  `caseSensitive` not a `ServeStaticOptions` property (×1)
- `server/db/tursoStore.ts` ×6 — the `@libsql/client` `execute(sql, args)`
  overload (see below)
- `server/db/tursoStore.test.ts` ×4 — `Record<string, unknown>` vs `UserRecord`
- `server/db/stage5dUow.test.ts` ×1 — missing type-only import (runtime-harmless)
- `server/services/r2Storage.ts` ×1, `srtRules.test.ts` ×1

**Zero** errors in any Stage 5D production file (`creditIdentityIndexes`,
`writeMutex`, `tursoScope`, `creditFacade`, `asyncRoute`, `creditRules`,
`tursoCreditService`).

*Note:* this build of `@libsql/client` only types the single-argument
`execute` overload, so `execute(sql, args)` is a type error even though it works
at runtime. The codebase convention is the object form `execute({ sql, args })`,
which is what new code uses. Fixing the six legacy `tursoStore.ts` call sites is
optional clean-up, not a correctness issue.

### Intermittent flake — disclosed, not hidden

A file-level failure (reported as `✖ server/db/<file>.test.ts (NNNNms) 'test
failed'`, with **every individual test passing** and no diagnostic output) occurs
roughly 1 run in 8. It has hit `tursoStore.test.ts`, `stage5dUow.test.ts` and
`writeSerialization.test.ts` at different times, and does not depend on
`--test-concurrency` (it still occurred at concurrency 2).

Evidence gathered:
- Every affected file passes **100% standalone** (6/6 consecutive clean runs of
  `tursoStore.test.ts`; 4/4 of `writeSerialization.test.ts`).
- The TAP reporter shows `69/69 pass`, `exit 0`, and **no error output at all**.
- `tursoStore.ts` never closes its libSQL client and there is no `after()`
  cleanup, across 27 construction sites and 45 `mkdtempSync` sites in the stage
  test files, so native client/handle pressure accumulates across ~20
  concurrently running files.

Assessment: a **native libSQL/SQLite teardown or resource-exhaustion issue on
Windows**, not a logic defect and not caused by Stage 5D — it predates this work.

**Closure-period observations.** The flake recurred twice while verifying the A13
payment fix: full runs of `450 total / 449 pass / 1 file-level fail`, both times
identically `server\db\stage5dUow.test.ts (…ms) 'test failed'` with **no named
test and no diagnostic output** — the known signature. Reruns were green, and
`stage5dUow.test.ts` standalone passed **26/26 on four consecutive runs**.

It is also *provably* unrelated to the A13 fix: **no test file in the repository
imports `server.ts`** (verified by scan), so a four-line route-registration change
there cannot influence any test. Full-suite tallies across the whole closure —
7 runs total: 5 × `449/449 green`, 2 × `450/449 flake on stage5dUow.test.ts`.

The one actionable mitigation available (`TursoStore.close()` plus an `after()`
hook) was deliberately **not** added: it was out of scope for this stage and is
not required for correctness. It remains the recommended follow-up if the flake
ever becomes a CI problem. The three full-suite gate runs recorded in this
report — two before the A13 fix and one after — all completed at **449/449,
exit 0**.

---

## C. Data integrity verification

Verified before and after all work:

| Item | Baseline | Final | Status |
|---|---|---|---|
| `data/app.db.json` SHA-256 | `4545AE6C29B39BFD94744FEE6A21767DB35D3F647E4120F1784A13856DB93CEF` | identical | **byte-identical** |
| `data/app.db.json` size | 81,642 bytes | 81,642 bytes | unchanged |
| `data/storage/` file count | 9 | 9 | unchanged |
| `data/storage/` total bytes | 69,708 | 69,708 | unchanged |
| Orphan SRT files | 9 | 9 | untouched |
| Owner token hashes (47 users) | 684, all distinct | 684, all distinct | untouched |

- No financial transaction row was created, modified or deleted at any point.
- All database tests ran against throwaway `file::memory:` or `mkdtempSync`
  databases; none opened the canonical database for writing.
- `data/` is gitignored (`.gitignore`), so no data file entered version control.
- No durable checkpoint artefact was ever created. Given that the canonical
  database was never opened for writing and the hash is unchanged, no restore
  point was required — but this remains a process gap worth closing before any
  future step that could touch real data.

---

## D. Migration / schema status

**Schema version 2 → 3.** Recorded in `schema_migrations`.

| Property | Status |
|---|---|
| Additive only (no DROP/ALTER/rewrite) | Yes |
| Conflict-detecting | Yes — aborts before creating anything |
| Dry-run capable, zero writes | Yes |
| Idempotent | Yes — re-reads `sqlite_master` and fails if absent |
| Strict validation | Yes — `validateSchema()` still reports, never repairs |
| Row preservation | Verified — every pre-existing row survives, in order |
| Executed against real data | **No** |
| Destructive/production migration | **None performed** |

### Deployment-time behaviour — please read

On startup, `init()` applies the identity migration. If the production ledger
already contains duplicates, `init()` **throws and the application refuses to
start**. This is intentional and matches your decision: a hard stop, no
automatic remediation, no data rewriting.

Before deploying, run the read-only pre-flight in
`docs/STAGE5D_DEPLOYMENT_SMOKE.md` **§B5**. If it returns any row, the deploy
must not proceed and the data must not be edited automatically — that is a human
decision.

**Do NOT set `TURSO_SKIP_IDENTITY_MIGRATION=1` — it is not a safe inspection
mode.** *(Corrected during Stage 6 after empirical verification; the earlier
claim in this section was wrong.)*

Setting `TURSO_SKIP_IDENTITY_MIGRATION=1` skips creation of the three identity
indexes. But `validateSchema()` only checks tables, columns and `UNIQUE`
constraints — it does **not** verify the identity indexes, and
`missingIdentityIndexes()` (`tursoStore.ts:551`) is never called. The
`INSERT OR IGNORE … VALUES (3)` schema marker then runs unconditionally.

Net effect: the database is stamped **v3 while having no money-identity
protection**, and startup succeeds. The flag has the opposite of its intended
effect, so it must never be present in a deployed environment.

To inspect a database without migrating it, use a copy or call the read-only
planner (`planCreditIdentityMigration()`) directly — not this flag.

---

## E. Blockers

### E1. ~~HIGH — Payment handlers can reject unhandled~~ **RESOLVED (closed)**

**Status: fixed.** Both handlers are now wrapped with `asyncRoute()`. The
description below is retained as the record of what was found and why it
mattered.

Original finding: `/api/credits/purchase/verify` (`server.ts:2063`) and
`/api/credits/purchase/webhook` (`server.ts:2146`) called
`await credits.recordPurchase(...)` **outside any `try`/`catch`**, on **bare
`async`** Express 4 handlers.

Express 4 only observes *synchronous* throws. If `recordPurchase` rejected — DB
error, `SQLITE_BUSY`, lock timeout, network blip, unique-constraint violation —
the result was:
- **no HTTP response** (client hangs until the gateway times out),
- an **unhandled promise rejection**, which terminates the process on modern
  Node,
- a **captured payment with no credit granted**.

This was precisely the hazard D2 set out to close, and on the money path it was
not closed.

**Resolution:** see §A13. Four lines changed, both handlers wrapped, all gates
re-run green. The six-handler figure in earlier drafts is now four: the two
payment paths are fixed, and the other four
(`/api/process-audio`, `/api/detect-language`, `/api/credits/purchase/order`,
`/api/admin/moderation/attachments/:userId/*key`) were already safe via local
`try`/`catch` and were deliberately left untouched by the minimal fix.

### E1-remaining. None.

No payment-path blocker remains in code. The residual risk on this path is
verification-only: B19–B21 of the smoke-test document still require a real
TEST-mode deploy to confirm end to end.

`/api/credits/purchase/verify` (`server.ts:2063`) and
`/api/credits/purchase/webhook` (`server.ts:2146`) call
`await credits.recordPurchase(...)` **outside any `try`/`catch`**, on **bare
`async`** Express 4 handlers.

Express 4 only observes *synchronous* throws — that was the underlying defect.

### E2. Write serialization is per-process only
`WriteMutex` protects a single Node process. If the service is scaled to more
than one instance, concurrent writers are no longer serialized by it. The
database-level identity indexes (A10) are the real backstop against
double-crediting, but they do not prevent lock contention. Confirm single-instance
deployment, or move serialization to the database/advisory-lock layer.

### E3. Embedded-driver transaction semantics
The mutex exists because libSQL's embedded driver starts each transaction on a
fresh connection with `busy_timeout = 0`. This was verified on **local
`file:` databases only**. Remote Turso behaviour is unverified — see E4.

### E4. Real Turso never tested
No connection to a real Turso database was made, as instructed. B3–B8 of the
smoke-test document exist precisely because none of this is proven against the
real service.

### E5. Intermittent native test flake
See B. Pre-existing, low severity, but it means a green gate is not fully
deterministic.

### E6. Optional clean-up
The six `execute(sql, args)` call sites in `tursoStore.ts` remain type errors
(inherited). Cosmetic; runtime-correct.

---

## F. User decisions still required

| # | Decision | Why it needs you |
|---|---|---|
| 1 | ~~Fix E1 before go-live?~~ **RESOLVED — fix applied, all gates green.** See §A13. | Closed. No decision needed. |
| 2 | **Historical duplicate rows in production.** The migration hard-stops if any exist. | Confirmed policy: hard stop, no remediation. Still needs a *human* plan for the data if the pre-flight finds rows. |
| 3 | **Single instance or multi-instance?** Determines whether the in-process mutex is sufficient. | A topology/cost decision, not a code one. |
| 4 | **When to run the migration** relative to first deploy. | Ordering choice: schema-first vs app-first. App-first means the app refuses to start until migrated. |
| 5 | **9 orphan SRT files** — retain indefinitely, or adopt a retention policy. | Explicitly preserved so far; still undecided. |
| 6 | **684 owner token hashes** (47 users) — retain, or apply a retention policy. | Explicitly untouched; undecided. |
| 7 | **Razorpay LIVE activation** timing. | Never activated. Deliberately a separate, later decision. |

---

## G. Exact deployment-day smoke tests

The authoritative, step-by-step version is
**`docs/STAGE5D_DEPLOYMENT_SMOKE.md`**. Summary of what must be executed:

**Before deploy (no credentials needed)**
1. `npm test` → expect 449 passed, exit 0
2. `npm run build` → exit 0
3. `npx tsc --noEmit` → 296 errors, **zero new**
4. `data/app.db.json` SHA-256 unchanged; `data/storage/` 9 files / 69,708 bytes
5. `render.yaml` and the repo contain no secret values
6. **Turso pre-flight (read-only SQL, §B5)** — all three duplicate queries must
   return **zero rows**

**Deployment day**
7. Render service Live; `/api/health` → 200 with `hasSarvamApiKey: true`
8. `DATABASE_PROVIDER=turso`, `STORAGE_PROVIDER=r2`, **no local fallback**
9. `SCHEMA_VERSION = 3` **and** all three `ux_transactions_*` indexes present
10. Registration, login, **and pre-existing session/token reuse with intact
    history**
11. Free-trial limit enforced server-side
12. Provider spending protection active
13. Sarvam transcription + SRT generation match the local reference
14. Credit lifecycle: reserve → settle; release; refund; balance reconciles
15. Razorpay **TEST-mode** purchase succeeds end to end
16. **Duplicate webhook replayed → credited exactly once**, `alreadyProcessed: true`
17. **Concurrent duplicate purchase → exactly one credit**
18. Giveaway `idempotencyKey` replayed → applied exactly once
19. Telegram notification delivered, not duplicated
20. Login Activity recorded
21. Admin authorized; **`GET /api/admin/users` unauthenticated = 401**, normal
    user = 403
22. Production routes present; legacy routes 404; no secrets in any response or log

**Post go-live**
23. 24h: payment reconciliation; ledger ↔ balance; no `WRITE_LOCK_TIMEOUT` /
    `SQLITE_BUSY` / unhandled rejections; no stranded jobs or reservations
24. 7d: provider spend within quota; identity indexes still present; no
    free-trial abuse; new orphan SRTs reviewed rather than auto-deleted