import type { Scope } from 'effect'
import { Effect, Layer } from 'effect'
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
 * optional `attachLive` capture exposes the supplied `enqueue`
 * callback through `liveEnqueueRef` so core-level transport tests can
 * exercise the live-attachment path without standing up jsdom.
 */
const make = (config?: {
  readonly initialMessages?: ReadonlyArray<string>
  readonly captureAttachLive?: boolean
}): {
  readonly layer: Layer.Layer<TransportAdapter>
  readonly sentSink: string[]
  readonly liveEnqueueRef: { current: ((raw: string) => void) | null }
} => {
  const sentSink: string[] = []
  const initialMessages = config?.initialMessages ?? []
  const liveEnqueueRef: { current: ((raw: string) => void) | null } = { current: null }
  const attachLive: (enqueue: (raw: string) => void) => Effect.Effect<void, never, Scope.Scope> = (
    enqueue
  ) =>
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
  return { layer: Layer.succeed(TransportAdapter, adapter), sentSink, liveEnqueueRef }
}

export { make }
