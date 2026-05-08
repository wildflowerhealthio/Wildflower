import { Effect, Layer } from 'effect'
import { PlatformAdapter } from './platform-adapter.ts'

/**
 * Capturing-stub `Layer<PlatformAdapter>` for tests. The stub's
 * `bareSender` pushes every encoded outbound string into the supplied
 * `sent` array; its `drainInitial` returns the supplied
 * `initialMessages` (default empty). Drop the layer into any program
 * that uses bridge senders or the transport — no platform module
 * loads.
 *
 * Re-exported as the `TestPlatformAdapterLayer` namespace from
 * `effect-messaging-core`'s barrel. Construct with {@link make}.
 *
 * @example
 * ```ts
 * import { TestPlatformAdapterLayer } from 'effect-messaging-core'
 *
 * const { layer, sentSink } = TestPlatformAdapterLayer.make()
 * Effect.runSync(SomeBridge.Web.send({ _tag: 'X', ... }).pipe(Effect.provide(layer)))
 * expect(JSON.parse(sent[0])).toEqual({ _tag: 'X', ... })
 * ```
 */
const make = (config?: {
  readonly initialMessages?: ReadonlyArray<string>
}): { layer: Layer.Layer<PlatformAdapter>; sentSink: string[] } => {
  const sentSink: string[] = []
  const initialMessages = config?.initialMessages ?? []
  const adapter: PlatformAdapter['Type'] = {
    bareSender: (encoded) =>
      Effect.sync(() => {
        sentSink.push(encoded)
      }),
    drainInitial: Effect.succeed(initialMessages),
  }
  return { layer: Layer.succeed(PlatformAdapter, adapter), sentSink }
}

export { make }
