import type { Queryable, Unsubscribe } from '@livestore/livestore'
import { Effect } from 'effect'

/**
 * Structural subset of the livestore Store API that `subscribeUntil`
 * actually touches — a snapshot read plus a callback-style subscribe
 * that returns an unsubscribe handle. Mirrors the local
 * {@link SubscribableStore} interface in
 * `shared-structures-core/process-daemon/watchSnapshots.ts`: callers can
 * pass either a real livestore Store or a test double with the same
 * shape without depending on the full `Store<TSchema, ...>` type.
 */
interface QueryableSubscribableStore {
  query<TResult>(query: Queryable<TResult>): TResult
  subscribe<TResult>(query: Queryable<TResult>, onUpdate: (value: TResult) => void): Unsubscribe
}

/**
 * Suspend until a livestore query emits a value satisfying `predicate`,
 * or the surrounding fiber is interrupted. Returns the first matching
 * value.
 *
 * Two call shapes:
 *
 *  - **Refinement** — `predicate` is a TypeScript type guard
 *    `(value: A) => value is B`. The returned Effect resolves to `B`
 *    (narrower than the query's emit type). Use this when the wait is
 *    meaningful *because* it asserts something about the shape (e.g.
 *    "fields are non-null", "discriminator is `Ready`"), so consumers
 *    don't need to re-check what the predicate already guaranteed.
 *  - **Plain predicate** — `predicate: (value: A) => boolean`. The
 *    Effect resolves to `A` unchanged.
 *
 * Implementation:
 *  1. Snapshot via `store.query` — if the current value already
 *     satisfies `predicate`, succeed immediately without ever entering
 *     `Effect.async`. (This is purely an optimisation; livestore's
 *     `subscribe` callback fires synchronously with the current value
 *     too, so step 2 would also pick it up. The snapshot bypasses the
 *     async round-trip when the result is already available.)
 *  2. Otherwise, `Effect.async` + `store.subscribe`. The predicate gates
 *     the callback, so the synchronous initial emit and every future
 *     emit are handled by the same branch. Resumes on first match;
 *     unsubscribes on success and on interruption.
 *
 * No internal timeout — callers add their own via
 * `Effect.timeoutFail(...)` or `Effect.timeoutTo(...)` depending on
 * whether they want a tagged error or a tagged outcome.
 *
 * @example Refinement — narrow nullable fields
 * ```ts
 * interface ReadyTunnel { running: true; subdomain: string; rootDomain: string }
 * const isReady = (s: TunnelStateRow): s is ReadyTunnel =>
 *   s.running && s.subdomain !== null && s.rootDomain !== null
 *
 * const tunnel = yield* subscribeUntil(store, TunnelState.queries.current$, isReady)
 * // `tunnel.subdomain` and `tunnel.rootDomain` are `string`, not `string | null`.
 * ```
 *
 * @example Plain predicate — pure wait gate
 * ```ts
 * yield* subscribeUntil(store, TunnelState.queries.current$, (s) => s.running).pipe(
 *   Effect.timeoutFail({
 *     duration: Duration.seconds(15),
 *     onTimeout: () => new TunnelLaunchTimedOut(),
 *   })
 * )
 * ```
 */
interface SubscribeUntil {
  <A, B extends A>(
    store: QueryableSubscribableStore,
    query: Queryable<A>,
    refinement: (value: A) => value is B
  ): Effect.Effect<B>
  <A>(
    store: QueryableSubscribableStore,
    query: Queryable<A>,
    predicate: (value: A) => boolean
  ): Effect.Effect<A>
}

const subscribeUntil: SubscribeUntil = <A>(
  store: QueryableSubscribableStore,
  query: Queryable<A>,
  predicate: (value: A) => boolean
): Effect.Effect<A> =>
  Effect.suspend(() => {
    // Snapshot first — livestore's `subscribe` callback fires
    // synchronously with the current value, but resolving the snapshot
    // here lets the common "already satisfied" case bypass the
    // `Effect.async` indirection (and the `unsubscribe` reference, which
    // would otherwise be touched inside its own temporal dead zone if
    // the predicate matched on the initial emit).
    const current = store.query(query)
    if (predicate(current)) return Effect.succeed(current)

    return Effect.async<A>((resume) => {
      let resumed = false
      const unsubscribe = store.subscribe(query, (value) => {
        if (resumed || !predicate(value)) return
        resumed = true
        unsubscribe()
        resume(Effect.succeed(value))
      })
      return Effect.sync(() => {
        if (!resumed) {
          resumed = true
          unsubscribe()
        }
      })
    })
  })

export { subscribeUntil }
export type { QueryableSubscribableStore }
