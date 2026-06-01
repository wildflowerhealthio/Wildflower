import type { Scope } from 'effect'
import { Effect, Layer, Queue } from 'effect'
import type { BareSenderFunction } from './bare-sender.ts'
import { TransportAdapter } from './transport-adapter.ts'

/**
 * Capturing-stub `Layer<TransportAdapter>` for tests.
 *
 * @example
 * ```ts
 * import { TestPlatformAdapterLayer } from 'effect-messaging-core'
 *
 * const { layer, sentSink } = TestPlatformAdapterLayer.make()
 * Effect.runSync(SomeBridge.Web.send({ _tag: 'X' }).pipe(Effect.provide(layer)))
 * expect(JSON.parse(sentSink[0])).toEqual({ _tag: 'X' })
 * ```
 *
 * @remarks
 * `bareSender` records every encoded outbound string two ways: it pushes
 * onto the synchronous `sentSink` array — for callers that drive
 * `Bridge.send` directly under `Effect.runSync` and read the array right
 * after — and offers it to the `sentQueue` Effect queue. The queue is
 * the deterministic seam for transport tests: a `sendMessage` rides the
 * async outbox pump, so the array isn't populated synchronously; awaiting
 * `Queue.take`/`takeN` blocks until the pump actually flushes, and
 * `Queue.poll` confirms nothing flushed without a sleep.
 *
 * `drainInitial` returns `initialMessages` (default `[]`); the optional
 * `attachBareSender` capture exposes the supplied `bareSender` callback
 * through `liveBareSenderRef` so core-level transport tests can exercise
 * the live-attachment path without standing up jsdom.
 */
const make = (config?: {
  readonly initialMessages?: ReadonlyArray<string>
  readonly captureBareSenderLive?: boolean
}): {
  readonly layer: Layer.Layer<TransportAdapter>
  readonly sentSink: string[]
  readonly sentQueue: Queue.Queue<string>
  readonly liveBareSenderRef: { current: BareSenderFunction | null }
} => {
  const sentSink: string[] = []
  const sentQueue = Effect.runSync(Queue.unbounded<string>())
  const initialMessages = config?.initialMessages ?? []
  const liveBareSenderRef: { current: BareSenderFunction | null } = {
    current: null,
  }
  const attachBareSender: (
    bareSender: BareSenderFunction
  ) => Effect.Effect<void, never, Scope.Scope> = (bareSender) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        liveBareSenderRef.current = bareSender
        return bareSender
      }),
      () =>
        Effect.sync(() => {
          if (liveBareSenderRef.current === bareSender) liveBareSenderRef.current = null
        })
    ).pipe(Effect.asVoid)

  const adapter: TransportAdapter['Type'] = {
    bareSender: (encoded) =>
      Effect.suspend(() => {
        sentSink.push(encoded)
        return Queue.offer(sentQueue, encoded).pipe(Effect.asVoid)
      }),
    drainInitial: Effect.succeed(initialMessages),
    ...(config?.captureBareSenderLive === true ? { attachBareSender: attachBareSender } : {}),
  }
  return {
    layer: Layer.succeed(TransportAdapter, adapter),
    sentSink,
    sentQueue,
    liveBareSenderRef,
  }
}

export { make }
