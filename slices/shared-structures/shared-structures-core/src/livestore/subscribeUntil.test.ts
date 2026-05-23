import type { Queryable, Unsubscribe } from '@livestore/livestore'
import { Duration, Effect, Exit, Fiber } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { subscribeUntil, type QueryableSubscribableStore } from './subscribeUntil.ts'

// ---------------------------------------------------------------------------
// Fake store — drives `subscribeUntil` without booting a real livestore.
// Lets each test orchestrate snapshot reads and async emits independently.
// ---------------------------------------------------------------------------

interface FakeStoreHandle<T> {
  readonly store: QueryableSubscribableStore
  /**
   * Push a new value to all current subscribers. Mirrors livestore's
   * "on commit" wakeup: subscribers receive the updated snapshot
   * asynchronously, not synchronously inside `commit`.
   */
  readonly emit: (value: T) => void
  /** Number of currently registered subscribers. */
  readonly subscriberCount: () => number
}

const makeFakeStore = <T>(initial: T): FakeStoreHandle<T> => {
  let current = initial
  const listeners = new Set<(value: T) => void>()
  const store: QueryableSubscribableStore = {
    query<TResult>(_query: Queryable<TResult>): TResult {
      // The helper passes a single `Queryable<T>` and reads a `T` back;
      // the fake ignores the query identity and returns its singleton
      // snapshot. The unsafe cast is local to the test double and is
      // bracketed by the helper's generic constraints at the call site.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return current as unknown as TResult
    },
    subscribe<TResult>(
      _query: Queryable<TResult>,
      onUpdate: (value: TResult) => void
    ): Unsubscribe {
      // Forward emits through the same identity cast — see comment in
      // `query` above.
      const wrapped = (value: T): void => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        onUpdate(value as unknown as TResult)
      }
      listeners.add(wrapped)
      // Livestore's real `subscribe` fires the callback synchronously
      // with the current value before returning. Mirror that so the
      // helper exercises the same edge case (initial emit + predicate
      // gate) it would in production.
      wrapped(current)
      return () => {
        listeners.delete(wrapped)
      }
    },
  }
  return {
    store,
    emit: (value: T) => {
      current = value
      for (const listener of listeners) listener(value)
    },
    subscriberCount: () => listeners.size,
  }
}

// `subscribeUntil` forwards `query` straight through to the fake's
// `store.query` / `store.subscribe`, both of which ignore the runtime
// value. The polymorphic factory keeps `A` inferred from the predicate
// (and from `FakeStoreHandle<A>`) rather than collapsing it to
// `unknown` at the call site. Cast is local to test scaffolding.
const queryStubFor = <A>(): Queryable<A> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ({}) as Queryable<A>

interface ReadyPayload {
  readonly ready: boolean
  readonly payload: string
}

interface ReadyCounter {
  readonly ready: boolean
  readonly n: number
}

// ---------------------------------------------------------------------------

describe('subscribeUntil', () => {
  it('returns the current snapshot synchronously when the predicate already matches', async () => {
    const { store, subscriberCount } = makeFakeStore<ReadyPayload>({
      ready: true,
      payload: 'snapshot',
    })
    const result = await Effect.runPromise(
      subscribeUntil(store, queryStubFor<ReadyPayload>(), (s) => s.ready)
    )
    expect(result).toEqual({ ready: true, payload: 'snapshot' })
    // Snapshot path bypasses `Effect.async`, so no subscriber was
    // installed even transiently.
    expect(subscriberCount()).toBe(0)
  })

  it('waits for an async emit that satisfies the predicate, returning that value', async () => {
    const handle = makeFakeStore<ReadyPayload>({ ready: false, payload: 'initial' })
    const fiber = Effect.runFork(
      subscribeUntil(handle.store, queryStubFor<ReadyPayload>(), (s) => s.ready)
    )
    // The async path installs exactly one subscriber while waiting.
    // Yield to the microtask queue so `Effect.async`'s register
    // callback has run before we check.
    await new Promise((resolve) => setImmediate(resolve))
    expect(handle.subscriberCount()).toBe(1)

    handle.emit({ ready: true, payload: 'first-match' })
    const result = await Effect.runPromise(Fiber.join(fiber))
    expect(result).toEqual({ ready: true, payload: 'first-match' })
    // Unsubscribed on success.
    expect(handle.subscriberCount()).toBe(0)
  })

  it("does not resume on emits whose predicate doesn't match", async () => {
    const handle = makeFakeStore<ReadyPayload>({ ready: false, payload: 'initial' })
    const fiber = Effect.runFork(
      subscribeUntil(handle.store, queryStubFor<ReadyPayload>(), (s) => s.ready)
    )
    await new Promise((resolve) => setImmediate(resolve))

    // Non-matching emit: fiber should stay parked.
    handle.emit({ ready: false, payload: 'still-not-ready' })
    expect(handle.subscriberCount()).toBe(1)

    // Matching emit: fiber resumes.
    handle.emit({ ready: true, payload: 'now-ready' })
    const result = await Effect.runPromise(Fiber.join(fiber))
    expect(result).toEqual({ ready: true, payload: 'now-ready' })
  })

  it('unsubscribes on interrupt without resuming', async () => {
    const handle = makeFakeStore<ReadyPayload>({ ready: false, payload: 'initial' })
    const fiber = Effect.runFork(
      subscribeUntil(handle.store, queryStubFor<ReadyPayload>(), (s) => s.ready)
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(handle.subscriberCount()).toBe(1)

    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(handle.subscriberCount()).toBe(0)
  })

  it('composes with Effect.timeoutFail when the predicate never matches', async () => {
    class Late {
      readonly _tag = 'Late'
    }
    const handle = makeFakeStore<{ readonly ready: boolean }>({ ready: false })
    const exit = await Effect.runPromiseExit(
      subscribeUntil(
        handle.store,
        queryStubFor<{ readonly ready: boolean }>(),
        (s) => s.ready
      ).pipe(Effect.timeoutFail({ duration: Duration.millis(10), onTimeout: () => new Late() }))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // Timeout disposes the inner Effect via interrupt, which routes
    // through the helper's finalizer and unsubscribes.
    expect(handle.subscriberCount()).toBe(0)
  })

  it('ignores additional matching emits after the first resume', async () => {
    const handle = makeFakeStore<ReadyCounter>({ ready: false, n: 0 })
    const fiber = Effect.runFork(
      subscribeUntil(handle.store, queryStubFor<ReadyCounter>(), (s) => s.ready)
    )
    await new Promise((resolve) => setImmediate(resolve))

    handle.emit({ ready: true, n: 1 })
    const result = await Effect.runPromise(Fiber.join(fiber))
    expect(result).toEqual({ ready: true, n: 1 })

    // A second matching emit after resume must not throw or re-trigger
    // anything: the helper's `resumed` latch + `unsubscribe()` both
    // guarantee no second resume call lands on Effect.async's resume,
    // and no listener remains registered to receive the value.
    expect(handle.subscriberCount()).toBe(0)
    handle.emit({ ready: true, n: 2 })
    expect(handle.subscriberCount()).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // Refinement overload — narrows the value type without an extra cast.
  // ---------------------------------------------------------------------------
  it('narrows the result type when the predicate is a type guard', async () => {
    interface Pending {
      readonly kind: 'pending'
      readonly subdomain: null
    }
    interface Ready {
      readonly kind: 'ready'
      readonly subdomain: string
    }
    type Either = Pending | Ready
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const isReady = (v: Either): v is Ready => v.kind === 'ready'

    const handle = makeFakeStore<Either>({ kind: 'pending', subdomain: null })
    const fiber = Effect.runFork(subscribeUntil(handle.store, queryStubFor<Either>(), isReady))
    await new Promise((resolve) => setImmediate(resolve))

    handle.emit({ kind: 'ready', subdomain: 'sub' })
    const result = await Effect.runPromise(Fiber.join(fiber))

    // Type-level: `result` is `Ready`, not `Either`. Assigning to a
    // `Ready`-typed binding fails to compile if the refinement overload
    // ever regresses to returning `A` (the union).
    const narrowed: Ready = result
    // Runtime: subdomain is the non-null string the guard asserted.
    expect(narrowed.subdomain).toBe('sub')
  })
})
