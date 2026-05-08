import type { Scope } from 'effect'
import { Effect, Layer } from 'effect'
import { type Bridge, BridgeTransport, PlatformAdapter } from 'effect-messaging-core'
import * as WebPlatformAdapter from './web-platform-adapter.ts'

/**
 * Browser-side cross-process transport. Thin wrapper around the
 * platform-agnostic {@link BridgeTransport.make} core in
 * `effect-messaging-core`; this file supplies only the Web-specific
 * wiring (the {@link PlatformAdapter} Layer comes from
 * {@link WebPlatformAdapter.make}).
 *
 * The dispatch core (handler resolution, tag-collision detection,
 * sender map, decode-then-route fiber, error formatting) lives in
 * `effect-messaging-core`'s `BridgeTransport` namespace; tests for
 * that pipeline live there too.
 *
 * Re-exported as the `WebTransport` namespace from
 * `effect-messaging-react`'s barrel. Construct with {@link make}; the
 * resulting value's type is `WebTransport.WebTransport<Bridges>`.
 */

/** Tuple-positional layer requirement for the Web side of every wired bridge. */
type Layers<Bridges extends ReadonlyArray<Bridge.AnyBridge>> = Bridge.TransportLayers<
  Bridges,
  'Web'
>

/** Public Web transport surface — `sendMessage` only. */
interface WebTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly sendMessage: Bridge.SenderIntersection<Bridges, 'Web'>
}

/**
 * Construct a web {@link WebTransport}. The returned Effect is
 * scoped: compose with `Effect.scoped(...)` so the dispatch fiber,
 * the queue, and the window listener all release on scope close.
 *
 * @example
 * ```ts
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const transport = yield* WebTransport.make({bridges, layers})
 *     yield* transport.sendMessage({ _tag: 'RouteChanged', ... })
 *   })
 * )
 * Effect.runPromise(program.pipe(Effect.provide(loggerLayer)))
 * ```
 */
const make = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly layers: Layers<Bridges>
}): Effect.Effect<WebTransport<Bridges>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const transport: BridgeTransport.BridgeTransport<Bridges, 'Web'> = yield* BridgeTransport.make({
      bridges: config.bridges,
      layers: config.layers,
      side: 'Web',
    }).pipe(Effect.provide(Layer.succeed(PlatformAdapter, WebPlatformAdapter.make())))
    return { sendMessage: transport.sendMessage }
  })

export { make }
export type { Layers, WebTransport }
