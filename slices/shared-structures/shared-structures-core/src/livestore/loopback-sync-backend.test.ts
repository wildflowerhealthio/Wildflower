import { FetchHttpClient, KeyValueStore } from '@effect/platform'
import type { SyncBackend } from '@livestore/common'
import { EventSequenceNumber, type LiveStoreEvent } from '@livestore/common/schema'
import { Chunk, Effect, Option, Stream, SubscriptionRef } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { makeLoopbackSyncBackend } from './loopback-sync-backend.ts'

// ---------------------------------------------------------------------------
// Harness — instantiate the backend.
//
// `makeLoopbackSyncBackend()` returns a `SyncBackendConstructor`, whose Effect
// is typed as requiring `Scope | HttpClient | KeyValueStore` (the contract for
// any backend). This loopback touches none of them at runtime, so we discharge
// the trio with `Effect.scoped` plus the platform's in-memory layers purely to
// satisfy the types — the layers are never exercised.
// ---------------------------------------------------------------------------

const makeBackend = (): Promise<SyncBackend.SyncBackend> =>
  Effect.runPromise(
    makeLoopbackSyncBackend()({
      storeId: 'test-store',
      clientId: 'test-client',
      payload: undefined,
    }).pipe(
      Effect.provide(KeyValueStore.layerMemory),
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped
    )
  )

// Build a wire event at a given global sequence number. `parentSeqNum` points
// one back, mirroring how the leader threads its eventlog; the loopback only
// reads `seqNum`, so the rest is filler that keeps the value schema-shaped.
const makeEvent = (seqNum: number): LiveStoreEvent.Global.Encoded => ({
  name: 'v1.TestUpserted',
  args: {},
  seqNum: EventSequenceNumber.Global.make(seqNum),
  parentSeqNum: EventSequenceNumber.Global.make(seqNum - 1),
  clientId: 'test-client',
  sessionId: 'test-session',
})

const seqNumsOf = (items: ReadonlyArray<SyncBackend.PullResItem>): readonly number[] =>
  items.flatMap((item) => item.batch.map((entry) => entry.eventEncoded.seqNum))

describe('makeLoopbackSyncBackend', () => {
  it('echoes pushed events back on the live pull stream', async () => {
    const backend = await makeBackend()
    await Effect.runPromise(backend.push([makeEvent(1), makeEvent(2), makeEvent(3)]))

    // Drop the leading empty "caught up" page, then flatten whatever chunking
    // the queue produced and take the three echoed events.
    const echoed = await Effect.runPromise(
      backend.pull(Option.none(), { live: true }).pipe(
        Stream.drop(1),
        Stream.flatMap((item) => Stream.fromIterable(item.batch)),
        Stream.map((entry) => entry.eventEncoded.seqNum),
        Stream.take(3),
        Stream.runCollect
      )
    )

    expect(Chunk.toReadonlyArray(echoed)).toEqual([1, 2, 3])
  })

  it('emits an empty caught-up page before any pushed events', async () => {
    const backend = await makeBackend()
    const items = Chunk.toReadonlyArray(
      await Effect.runPromise(
        backend.pull(Option.none(), { live: true }).pipe(Stream.take(1), Stream.runCollect)
      )
    )

    expect(items).toHaveLength(1)
    expect(items[0]?.batch).toEqual([])
    expect(items[0]?.pageInfo).toEqual({ _tag: 'NoMore' })
  })

  it('returns a single empty NoMore page for non-live pulls', async () => {
    const backend = await makeBackend()
    const items = Chunk.toReadonlyArray(
      await Effect.runPromise(backend.pull(Option.none(), { live: false }).pipe(Stream.runCollect))
    )

    expect(items).toHaveLength(1)
    expect(items[0]?.batch).toEqual([])
    expect(items[0]?.pageInfo).toEqual({ _tag: 'NoMore' })
  })

  it('advances its head so a re-pushed sequence number is rejected', async () => {
    const backend = await makeBackend()
    // From ROOT (head = 0) an ascending batch is accepted and moves head to 2.
    await Effect.runPromise(backend.push([makeEvent(1), makeEvent(2)]))

    // Re-pushing seqNum 2 (<= head) violates the ascending-order guard.
    const error = await Effect.runPromise(backend.push([makeEvent(2)]).pipe(Effect.flip))
    expect(error._tag).toBe('ServerAheadError')

    // A genuinely ascending follow-up still succeeds (head was left at 2).
    await Effect.runPromise(backend.push([makeEvent(3)]))
  })

  it('echoes events pushed across multiple sequential batches in order', async () => {
    const backend = await makeBackend()
    await Effect.runPromise(backend.push([makeEvent(1)]))
    await Effect.runPromise(backend.push([makeEvent(2), makeEvent(3)]))

    const items = Chunk.toReadonlyArray(
      await Effect.runPromise(
        backend.pull(Option.none(), { live: true }).pipe(
          Stream.drop(1),
          Stream.takeUntil((item) => seqNumsOf([item]).includes(3)),
          Stream.runCollect
        )
      )
    )

    expect(seqNumsOf(items)).toEqual([1, 2, 3])
  })

  it('reports a connected backend that stays connected after connect', async () => {
    const backend = await makeBackend()
    expect(await Effect.runPromise(SubscriptionRef.get(backend.isConnected))).toBe(true)
    // `connect` requires a `Scope` (the backend contract lets a real backend
    // register teardown); discharge it with `Effect.scoped` — the loopback
    // registers nothing.
    await Effect.runPromise(Effect.scoped(backend.connect))
    expect(await Effect.runPromise(SubscriptionRef.get(backend.isConnected))).toBe(true)
  })

  it('advertises live-pull support in its capabilities', async () => {
    const backend = await makeBackend()
    expect(backend.supports).toEqual({ pullPageInfoKnown: true, pullLive: true })
    expect(backend.metadata.name).toBe('loopback-sync-backend')
  })
})
