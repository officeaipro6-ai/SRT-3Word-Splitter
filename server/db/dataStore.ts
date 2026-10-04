/**
 * Data-layer provider contract (TYPE-ONLY).
 *
 * Purpose: let the TypeScript compiler police the provider boundary instead of
 * `let store: any`, and give a future transaction-scoped repository layer a
 * contract to be written against.
 *
 * This file adds NO runtime behaviour. The two production providers are
 * unchanged by it:
 *   - `server/db/store.ts`     -> JSON file store
 *   - `server/db/tursoStore.ts` -> libSQL/Turso store
 *
 * It is deliberately not a persistence layer: it holds no client, opens no
 * connection and defines no query. It only describes shapes.
 */

/** Whole-database shape the JSON provider materialises in memory. */
import type { DbShape } from './types';
/*
 * Type-only imports on purpose: these must never create a runtime dependency,
 * and `server.ts` loads the Turso provider through a dynamic import.
 */
import type { DataStore } from './store';
import type { TursoStore } from './tursoStore';

/**
 * The store surface the CURRENT repositories in `server/db/repos.ts` are
 * written against.
 *
 * Every repository method is synchronous and is built from exactly two
 * primitives: a whole-database read (`snapshot()`) and a whole-database
 * read-modify-write (`mutate()`). Nothing narrower exists today.
 *
 * `TursoStore` deliberately does NOT satisfy this interface, and that is the
 * documented gap rather than a defect to paper over:
 *   - `snapshot()` returns `Promise<DbShape>` (async) instead of `DbShape`
 *   - `mutate()`/`mutateAsync()` throw, because persisting a whole-database
 *     snapshot is not implemented for libSQL
 *
 * Closing that gap means rewriting the repositories onto per-entity async store
 * calls; it is NOT a matter of loosening a type.
 */
export interface SyncDataStore {
  init(): Promise<void>;
  snapshot(): DbShape;
  mutate<T>(fn: (db: DbShape) => T): T;
  mutateAsync<T>(fn: (db: DbShape) => T): Promise<T>;
}

/**
 * The two production providers, as selected by `DATABASE_PROVIDER` in
 * `server.ts`.
 *
 * Typing the selected store as this union is what makes the compiler reject the
 * current `new UserRepo(store)` calls: neither branch is a `DataStore` when the
 * other is in play, so the synchronous repository constructors no longer accept
 * it. Those errors are the intended, recorded output of this contract.
 */
export type DataStoreProvider = DataStore | TursoStore;

/**
 * Transaction boundary for future transaction-scoped repositories.
 *
 * Semantics, identical for both providers:
 *   - `fn` receives a store scoped to a single transaction
 *   - resolving `fn` commits
 *   - throwing `fn` rolls back and rethrows the ORIGINAL error
 *
 * `TScopedStore` is the provider's transaction-scoped store: repositories are
 * constructed over it exactly as they are over the root store
 * (`new UserRepo(scoped)`), so a transaction never has to be threaded through
 * repository method signatures.
 *
 * `TScopedStore` is intentionally NOT libSQL's `Transaction`. The raw
 * `@libsql/client` transaction handle must never reach a repository: it would
 * let any caller bypass prepared statements, the JSON-blob decoders and the
 * schema rules that `TursoStore` enforces. For Turso, `TScopedStore` is
 * expected to be a thin per-entity facade bound to that handle.
 *
 * Status: IMPLEMENTED FOR TURSO as of Stage 5D. `TursoScope` implements
 * `UnitOfWork<TursoScope>` and `TursoStore.unitOfWork()` hands one out, so the
 * credit and provider-safety flows can commit atomically. Two properties are
 * structural rather than conventional: the scope exposes no `commit`/`rollback`
 * (only an `execute` runner), and nesting a transaction is rejected outright
 * instead of being silently tolerated. The JSON provider still has no transaction
 * concept, and does not need one: a single synchronous process makes its
 * read-modify-write sequences atomic by construction.
 */
export interface UnitOfWork<TScopedStore> {
  transaction<T>(fn: (scoped: TScopedStore) => Promise<T>): Promise<T>;
}
