# Stage 5D — Production Deployment Smoke Test

**Status:** documentation only. Nothing in this document has been executed.
No cloud connection was made, no deployment was performed, and Razorpay LIVE
was never activated while producing it.

**Target:** Render web service (`render.yaml`) + Turso (libSQL) + Cloudflare R2.

Every check below is written so it can be executed by hand against a real
deployment and produce an unambiguous PASS/FAIL. Where a check can be automated
it is marked **[auto]**; the rest need a human with a browser and a test card.

---

## How to use this document

Three gates, in order:

| Gate | When | Meaning if it fails |
|---|---|---|
| **A. Pre-deployment** | Before pushing/merging to the deploy branch | Do not deploy. The build is not safe. |
| **B. Deployment-day** | Immediately after the first deploy, before announcing | Roll back. Users cannot pay or transcribe. |
| **C. Post-go-live** | 24h and 7d after go-live | Investigate; may not require rollback. |

Do not proceed from A to B, or B to C, with any FAIL outstanding.

### Recording results

Log for each check: `PASS` / `FAIL` / `N-A`, plus timestamp and operator.
Keep the deploy log — the payment checks in B produce real financial rows that
later reconciliation depends on.

---

# A. Must pass before deployment

These are verified locally and must still pass in CI. They do **not** require
cloud credentials.

- [ ] **A1. Full test suite green** — `npm test` exits 0.
      Current expected: **449 passing, 0 failing.**
- [ ] **A2. Production build succeeds** — `npm run build` exits 0 and emits
      `dist/server.cjs` and `dist/index.html`.
- [ ] **A3. Typecheck delta is zero** — `npx tsc --noEmit`.
      Current expected: **296 errors, all pre-existing, zero new.**
      Any *new* error in `server/` blocks the deploy.
- [ ] **A4. Canonical local data unchanged** — `data/app.db.json` SHA-256 is
      `4545AE6C29B39BFD94744FEE6A21767DB35D3F647E4120F1784A13856DB93CEF`,
      81,642 bytes; `data/storage/` holds exactly 9 files / 69,708 bytes.
- [ ] **A5. `render.yaml` contains no secrets** — it must only reference
      secret *keys*, never secret *values*. Confirm `git grep -i
      "secret\|token\|key" render.yaml` shows only `key:` names.
- [ ] **A6. No LIVE payment keys in the repo** — Razorpay keys must come from
      Render env vars only.
- [ ] **A7. `.env` is not committed** — confirm `.env` is in `.gitignore` and
      absent from the tree.

---

# B. Deployment-day checks

Run in this order against the live Render URL. B1–B8 are **[auto]**-able; the
rest are manual.

## B1–B2. Startup and health

- [ ] **B1. Render reports the service as Live** and the deploy log shows the
      server binding to `PORT` (10000) with no crash loop.
- [ ] **B2. `GET /api/health` returns HTTP 200** with:
      - `status: "ok"`
      - `activeProvider` / `asrProvider` = the intended provider
      - `jobsEnabled: true`
      - **`hasSarvamApiKey: true`** — if false, transcription will fail
      - `hasApiKey` / `hasOlive` / `hasAzure` consistent with intent

      ```powershell
      (Invoke-WebRequest "$env:BASE/api/health").Content | ConvertFrom-Json |
        Select-Object status, activeProvider, asrProvider, jobsEnabled, hasSarvamApiKey
      ```

## B3–B4. Turso connection and schema

- [ ] **B3. Turso connection is live and is the active database.**
      `DATABASE_PROVIDER=turso`. Confirm the deploy log shows the Turso/libSQL
      client initialising and **no** fallback to a local JSON file.
      **[auto]** A local `data/app.db.json` appearing in production logs is a
      **FAIL** — see B22.
- [ ] **B4. `SCHEMA_VERSION` is 3 and all three credit identity indexes
      exist.** This is the most important schema check.

      ```sql
      SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;   -- expect 3
      SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ux_transactions_%';
      ```
      Expect exactly:
      - `ux_transactions_payment_id`
      - `ux_transactions_idempotency`
      - `ux_transactions_job_type`

      **If any index is missing, the app will REFUSE TO START** (by design).
      That refusal is protective, not a bug — do not bypass it.

## B5. Credit identity conflict pre-flight **[auto] — run before first deploy**

Stage 5D keeps historical duplicates as a **hard stop**: no automatic
remediation, no deletion, no rewriting. Run the read-only planner and confirm
the production ledger is clean *before* deploying the migration.

```sql
-- expect ZERO rows from each of these
SELECT paymentId, COUNT(*) c FROM transactions WHERE paymentId IS NOT NULL
  GROUP BY paymentId HAVING c > 1;
SELECT userId, idempotencyKey, type, COUNT(*) c FROM transactions
  WHERE idempotencyKey IS NOT NULL
  GROUP BY userId, idempotencyKey, type HAVING c > 1;
SELECT userId, jobId, type, COUNT(*) c FROM transactions
  WHERE jobId IS NOT NULL
  GROUP BY userId, jobId, type HAVING c > 1;
```

- [ ] All three return zero rows → deploy may proceed.
- [ ] Any row returned → **STOP.** Do not deploy. Escalate for a human
      decision. The data must not be edited automatically.

## B6–B8. Storage and the write path

- [ ] **B6. R2 read/write works.** Run one transcription (B11) and confirm the
      resulting audio/SRT is retrievable from Cloudflare R2 (not local disk).
      `STORAGE_PROVIDER=r2`.
- [ ] **B7. A write transaction commits.** The B11 job produces both a
      `creditTransactions` row and a `transactions`-backed job row.
- [ ] **B8. A rollback leaves nothing behind.** Force a failed job (e.g.
      submit unsupported audio) and confirm no orphan ledger row and no
      stranded reservation.

## B9–B11. Identity, sessions, free trial

- [ ] **B9. Registration works** and the new account receives `INITIAL_CREDITS`.
- [ ] **B10. Login works** for a newly registered account.
- [ ] **B11. Existing session/token reuse works** — an account that existed
      *before* the deploy can log in and see its **pre-existing credit balance
      and transaction history**. This is the check that proves the Turso
      migration preserved history.
- [ ] **B12. Free-trial limit is enforced.** A user who has exhausted
      `FREE_TRIAL_LIMIT` cannot obtain another free trial; a fresh user can.
      Confirm the server enforces this (it must not trust the client).

## B13–B15. Transcription pipeline

- [ ] **B13. Provider spending protection is active.** Submit a job and confirm
      a `providerSafety` row is written; confirm quota/cooldown settings are as
      intended.
- [ ] **B14. Sarvam transcription succeeds** on a known-good Odia sample and
      returns the expected language.
- [ ] **B15. SRT generation succeeds** and the output matches the locally
      verified reference for that sample. **[auto]** compare against the
      checkpoint SRT for the same input.

## B16–B19. Credit lifecycle and payments

- [ ] **B16. Reservation → settle** works: balance decreases by the expected
      amount and exactly one `DEBIT` + one `USAGE` row exist for the job.
- [ ] **B17. Release works:** a failed/cancelled job releases its reservation
      and the balance returns to its pre-job value.
- [ ] **B18. Refund works:** a finished job refunds correctly and the balance
      reconciles.
- [ ] **B19. Razorpay TEST-mode purchase succeeds** end to end. Use TEST keys
      and a TEST card only.

### Payment idempotency — the highest-value check in this document

- [ ] **B20. Duplicate webhook is harmless.** Replay the *same* webhook
      delivery (same `paymentId`) two or more times. Expect: HTTP 200 every
      time, the balance credited **exactly once**, and
      `alreadyProcessed: true` on replays.
- [ ] **B21. Concurrent duplicate purchase cannot double-credit.** Fire the
      verify call for one payment twice in parallel. Expect one credit, and at
      most one `PURCHASE` row for that `paymentId`.

      ```sql
      SELECT paymentId, COUNT(*) FROM transactions WHERE paymentId = ? GROUP BY paymentId;  -- expect 1
      SELECT COUNT(*) FROM transactions WHERE type='ADMIN_CREDIT' AND idempotencyKey = ?;     -- expect 1
      ```
- [ ] **B22. Giveaway idempotency holds.** Trigger the same admin
      giveaway/`idempotencyKey` twice; balance must change once.

## B23–B27. Notifications, activity, authorization

- [ ] **B23. Telegram notification delivered** for a completed job (test chat
      ID). Confirm the message is not sent twice for one job.
- [ ] **B24. Login Activity recorded** — a login appears in
      `GET /api/admin/login-activity` with the correct timestamp and user.
- [ ] **B25. Admin authorization works** — an admin account can read
      `GET /api/admin/users`.
- [ ] **B26. Unauthorized access is rejected:**

      ```powershell
      # no credentials -> MUST be 401
      (Invoke-WebRequest "$env:BASE/api/admin/users" -SkipHttpErrorCheck).StatusCode
      # a normal user token -> MUST be 403
      ```

      A **401** here is mandatory. A 200 is a security incident: stop and roll
      back immediately.
- [ ] **B27. Moderation attachment route is authorized** —
      `GET /api/admin/moderation/attachments/:userId/*key` rejects non-admins
      and does not trust the key from the URL.

## B28–B30. Surface and secret hygiene

- [ ] **B28. Production routes are registered** — spot-check:
      `/api/health`, `/api/process-audio`, `/api/detect-language`,
      `/api/credits/me`, `/api/credits/packs`,
      `/api/credits/purchase/order|verify|webhook`, `/api/jobs`,
      `/api/admin/users`, `/api/admin/login-activity`, `/api/community/*`.
- [ ] **B29. No legacy/old routes respond.** Confirm removed or renamed
      endpoints 404 rather than serving stale behaviour.
- [ ] **B30. No secrets are exposed in any response or log.** Check that
      `/api/health`, error payloads, and stack traces never contain
      `TURSO_AUTH_TOKEN`, `RAZORPAY_KEY_SECRET`, `R2_SECRET_ACCESS_KEY`,
      webhook secrets, or admin token hashes. `X-Content-Type-Options:
      nosniff` is present on attachment responses.

## B31. No local fallback in production

- [ ] **B31. There is no fallback to local JSON or local storage.** This is a
      hard requirement, because Render's free tier has no persistent disk —
      local writes would silently vanish on restart.

      Confirm all of:
      - `DATABASE_PROVIDER=turso` (never `json`)
      - `STORAGE_PROVIDER=r2` (never `local`)
      - no `data/app.db.json` written under `DATA_DIR` in production
      - no "falling back to local" lines in the deploy log

---

# C. Post-go-live checks

- [ ] **C1. Reconciliation sweep (24h).** Every captured TEST payment has
      exactly one `PURCHASE` row; total credited equals sum of expected plans.
- [ ] **C2. Ledger ↔ balance reconciliation (24h).** For a sample of users,
      opening balance + grants − usage = closing balance, and it matches the
      `users.credits` column.
- [ ] **C3. Error rate (24h).** No `WRITE_LOCK_TIMEOUT`, `SQLITE_BUSY`, or
      unhandled rejection in the logs. Any occurrence is a real incident.
- [ ] **C4. Queue health (24h).** No job stuck in `processing`; no reservation
      stranded without its settle/release.
- [ ] **C5. Spend and quota (7d).** Provider spend and failure counts are
      within `PROVIDER_*` thresholds; no runaway spend.
- [ ] **C6. Identity indexes still present (7d).** Re-run B4 — nothing should
      have dropped them.
- [ ] **C7. Free-trial abuse (7d).** No account has consumed more than
      `FREE_TRIAL_LIMIT`.
- [ ] **C8. Orphaned SRTs (7d).** New uploads that never produced a job are
      reviewed rather than auto-deleted.

---

## Known risks to re-verify after go-live

1. **Application-level write serialization is per process.** `TursoStore`
   serializes writes with an in-process FIFO mutex. If the app is ever scaled
   to **more than one instance**, that mutex no longer protects against
   concurrent writers. Single-instance is an assumption, not a guarantee — the
   database-level identity indexes (B4) are the real backstop for
   double-crediting, but they do not prevent lock contention.
2. **Historical duplicate transactions are a hard stop.** If B5 finds any, the
   app will not start. That is intentional.
3. **Payment handlers are now `asyncRoute()`-wrapped** (Stage 5D closure fix,
   final report §A13). A `recordPurchase` rejection returns a normal error
   response and a webhook retry is idempotent. B19–B21 still require a real
   TEST-mode deploy to confirm end to end — treat them as high priority.