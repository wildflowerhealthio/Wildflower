import type { Scope } from 'effect'
import { Effect, Layer } from 'effect'
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
 * `bareSender` pushes every encoded outbound string into `sentSink`;
 * `drainInitial` returns `initialMessages` (default `[]`); the
 * optional `attachBareSender` capture exposes the supplied `bareSender`
 * callback through `liveBareSenderRef` so core-level transport tests can
 * exercise the live-attachment path without standing up jsdom.
 */
const make = (config?: {
  readonly initialMessages?: ReadonlyArray<string>
  readonly captureBareSenderLive?: boolean
}): {
  readonly layer: Layer.Layer<TransportAdapter>
  readonly sentSink: string[]
  readonly liveBareSenderRef: { current: BareSenderFunction | null }
} => {
  const sentSink: string[] = []
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
      Effect.sync(() => {
        sentSink.push(encoded)
      }),
    drainInitial: Effect.succeed(initialMessages),
    ...(config?.captureBareSenderLive === true ? { attachBareSender: attachBareSender } : {}),
  }
  return {
    layer: Layer.succeed(TransportAdapter, adapter),
    sentSink,
    liveBareSenderRef,
  }
}

export { make }
