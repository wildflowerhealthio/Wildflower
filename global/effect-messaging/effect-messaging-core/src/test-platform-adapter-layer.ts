import type { Scope } from 'effect'
import { Effect, Layer } from 'effect'
import { BareSender } from './bare-sender.ts'
import { TransportAdapter } from './transport-adapter.ts'

/**
 * Capturing-stub `Layer` for tests — provides both
 * {@link TransportAdapter} (the broader platform shape used by
 * `BridgeTransport.make`) and {@link BareSender} (the narrower send
 * shape consumed by `Bridge.Host.send` / `Bridge.Web.send`). Both
 * resolve to the same backing object so a single `sentSink` captures
 * everything pushed through either path.
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
 * optional `attachLive` capture exposes the supplied `enqueue`
 * callback through `liveEnqueueRef` so core-level transport tests can
 * exercise the live-attachment path without standing up jsdom.
 */
const make = (config?: {
  readonly initialMessages?: ReadonlyArray<string>
  readonly captureAttachLive?: boolean
}): {
  readonly layer: Layer.Layer<TransportAdapter | BareSender>
  readonly sentSink: string[]
  readonly liveEnqueueRef: { current: ((raw: string) => Effect.Effect<void>) | null }
} => {
  const sentSink: string[] = []
  const initialMessages = config?.initialMessages ?? []
  const liveEnqueueRef: { current: ((raw: string) => Effect.Effect<void>) | null } = {
    current: null,
  }
  const attachLive: (
    enqueue: (raw: string) => Effect.Effect<void>
  ) => Effect.Effect<void, never, Scope.Scope> = (enqueue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        liveEnqueueRef.current = enqueue
        return enqueue
      }),
      () =>
        Effect.sync(() => {
          if (liveEnqueueRef.current === enqueue) liveEnqueueRef.current = null
        })
    ).pipe(Effect.asVoid)

  const adapter: TransportAdapter['Type'] = {
    bareSender: (encoded) =>
      Effect.sync(() => {
        sentSink.push(encoded)
      }),
    drainInitial: Effect.succeed(initialMessages),
    ...(config?.captureAttachLive === true ? { attachLive } : {}),
  }
  const layer = Layer.merge(
    Layer.succeed(TransportAdapter, adapter),
    Layer.succeed(BareSender, adapter)
  )
  return { layer, sentSink, liveEnqueueRef }
}

export { make }
