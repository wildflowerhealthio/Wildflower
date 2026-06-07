import { SyncBackend, validatePushPayload } from '@livestore/common'
import { EventSequenceNumber, type LiveStoreEvent } from '@livestore/common/schema'
import { Effect, Option, Queue, Ref, Stream, SubscriptionRef } from 'effect'

/**
 * An in-memory **loopback** LiveStore sync backend: it accepts pushed
 * events, echoes them straight back on its live pull stream, and persists
 * nothing. There is no network and no durable log — events flow
 * push → queue → pull once and are then dropped.
 *
 * ## Why this exists
 *
 * On a **local-only** store (no sync backend) `store.commit` is
 * `O(pending events)` and `pending` never drains, so it grows to the size
 * of the whole eventlog and commit latency grows without bound. The cost
 * is `SyncState.merge` validating the entire `pending` array on every
 * commit; the *only* thing that confirms and clears `pending` is the
 * backend-pull path advancing `backendHead`. With no backend the leader's
 * `backgroundBackendPulling` returns immediately, so nothing ever drains.
 *
 * Wiring *any* backend whose pull echoes pushed events back lets the
 * leader confirm them and advance `backendHead`, which bounds `pending`
 * (and therefore per-commit cost) to the in-flight, not-yet-confirmed
 * window. This loopback is the cheapest such backend: it does the
 * round-trip entirely in memory.
 *
 * A backend that merely *discarded* pushed events would NOT help — without
 * the echo-on-pull, `backendHead` never advances and `pending` never
 * shrinks. "Consume and ack" specifically means "echo back so the leader
 * confirms", not "black-hole".
 *
 * ## Why it needs no retention
 *
 * The leader opens a single long-lived **live** pull for the connection
 * (`livePull` defaults to `true`) and pushes its `pending` via a
 * background fiber. Pushed events are buffered in an unbounded queue and
 * delivered to that one live consumer exactly once, so there is no need to
 * retain a replayable history. `backendHead` is persisted across restarts,
 * so confirmed events are never re-pulled; on the first boot after this is
 * introduced the leader re-pushes the existing eventlog through the
 * loopback in batches (a one-time, background, O(eventlog) drain off the
 * synchronous commit path).
 *
 * ## Constraints
 *
 * Designed for **live** pulls (`supports.pullLive: true`, the adapter
 * default). The non-live pull path returns an empty `NoMore` page: a
 * loopback keeps no durable log to page through, and confirmation flows
 * via the push → live-echo round-trip. Do not set `livePull: false`
 * against this backend, or `pending` will not drain.
 */
const makeLoopbackSyncBackend = (): SyncBackend.SyncBackendConstructor => () =>
  Effect.gen(function* () {
    // The highest global sequence number accepted so far. Resets to ROOT
    // each session (the loopback has no durable head); the leader only
    // ever pushes events after its persisted `backendHead`, which is
    // always > ROOT, so `validatePushPayload`'s ascending-order guard
    // still holds against this fresh head.
    const headRef = yield* Ref.make(EventSequenceNumber.Client.ROOT.global)
    const isConnectedRef = yield* SubscriptionRef.make(true)
    // Unbounded so a push that races ahead of the live consumer subscribing
    // is buffered rather than lost; the single live pull drains it.
    const liveQueue = yield* Queue.unbounded<LiveStoreEvent.Global.Encoded>()

    // Emit one empty page first (mirrors how real backends signal "caught
    // up to the cursor" so the leader releases its pull mutex), then stream
    // each pushed batch straight back as an upstream advance.
    const pullLive: Stream.Stream<SyncBackend.PullResItem> = Stream.concat(
      Stream.make(SyncBackend.pullResItemEmpty()),
      Stream.fromQueue(liveQueue).pipe(
        Stream.chunks,
        Stream.map((chunk) => ({
          batch: [...chunk].map((eventEncoded) => ({ eventEncoded, metadata: Option.none() })),
          pageInfo: SyncBackend.pageInfoNoMore,
        }))
      )
    )

    return SyncBackend.of({
      isConnected: isConnectedRef,
      connect: SubscriptionRef.set(isConnectedRef, true),
      ping: Effect.void,
      pull: (_cursor, options) =>
        options?.live === true ? pullLive : Stream.make(SyncBackend.pullResItemEmpty()),
      push: (batch) =>
        Effect.gen(function* () {
          const currentHead = yield* Ref.get(headRef)
          yield* validatePushPayload(batch, currentHead)
          yield* Queue.offerAll(liveQueue, batch)
          // `validatePushPayload` already rejects an empty batch (it reads
          // `batch[0]`), so `last` is defined in practice; guard rather than
          // assert to keep the lint surface clean.
          const last = batch.at(-1)
          if (last !== undefined) {
            yield* Ref.set(headRef, last.seqNum)
          }
        }),
      metadata: {
        name: 'loopback-sync-backend',
        description:
          'In-memory loopback: echoes pushed events back on the live pull stream to drain LiveStore `pending`; persists nothing.',
      },
      supports: {
        pullPageInfoKnown: true,
        pullLive: true,
      },
    })
  })

export { makeLoopbackSyncBackend }
