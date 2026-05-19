import type { Queryable } from '@livestore/livestore'
import { Effect } from 'effect'

interface QueryableStore {
  query<T>(q: Queryable<T>): T
}

/**
 * WORKAROUND(livestore): `subscribeStream` does not run the
 * clientDocument's "ensure default row exists" path that a synchronous
 * `store.query` triggers. Without an upfront query, the daemon's first
 * stream emit returns an empty result and the schema decoder dies on it.
 *
 * Call this once at daemon startup against the clientDocument-backed
 * query whose row needs materializing. The query value is discarded —
 * the only purpose is the row-materialization side effect.
 */
const ensureDefaultRowExists = <T>(
  store: QueryableStore,
  query: Queryable<T>
): Effect.Effect<void> =>
  Effect.sync(() => {
    store.query(query)
  })

export { ensureDefaultRowExists }
