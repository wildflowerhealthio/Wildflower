import type { Scope } from 'effect'
import { Effect, Layer } from 'effect'
import {
  type BareSender,
  type Bridge,
  BridgeTransport,
  PlatformAdapter,
} from 'effect-messaging-core'
import type { WebViewMessageEvent } from 'react-native-webview'

/**
 * Expo-side cross-process transport. Thin wrapper around the
 * platform-agnostic {@link BridgeTransport.make} core in
 * `effect-messaging-core`; this file supplies only the Expo-specific
 * glue:
 *
 * - **Bare sender**: the imperative
 *   `webviewHandleRef.current.postMessage` call. Pre-mount (ref not
 *   yet populated by the WebView component) the send warns and
 *   drops; post-mount messages flow live to the page.
 * - **Initial messages**: the consumer hands typed values; the
 *   wrapper encodes each via the matching bridge's outbound schema
 *   and assembles them into the `injectedScript` string the consumer
 *   threads through
 *   `<EffectMessagingWebView injectedScript={...}>`. The page-side
 *   handler reads `window.__INITIAL_MESSAGES__` on construction and
 *   replays the strings through its own dispatch program.
 * - **Live attachment**: no platform-level listener is attached. The
 *   transport exposes an `onMessage(event)` callback the consumer
 *   wires to `<EffectMessagingWebView onMessage={...}>`; that
 *   callback enqueues the raw string into the dispatch fiber.
 *
 * The dispatch core (handler resolution, tag-collision detection,
 * decode-then-route fiber, error formatting) lives in
 * `effect-messaging-core`'s `BridgeTransport` namespace; tests for
 * that pipeline live there too.
 */

/** Tuple-positional layer requirement for the Host side of every wired bridge. */
type ExpoTransportLayers<Bridges extends ReadonlyArray<Bridge.AnyBridge>> = Bridge.TransportLayers<
  Bridges,
  'Host'
>

/** Imperative handle the WebView component populates via `forwardRef`. */
interface WebViewHandle {
  postMessage(data: string): void
}

/**
 * Public Expo transport surface. The consumer wires
 * `webviewHandleRef` to `<EffectMessagingWebView ref={...}>`,
 * `injectedScript` to `injectedScript`, and `onMessage` to
 * `onMessage`. `sendMessage` is the typed Effect-returning sender the
 * consumer uses to push messages to the page after mount.
 */
interface ExpoTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly sendMessage: Bridge.SenderIntersection<Bridges, 'Host'>
  readonly webviewHandleRef: { current: WebViewHandle | null }
  readonly injectedScript: string
  readonly onMessage: (event: WebViewMessageEvent) => void
}

/**
 * Construct an Expo {@link ExpoTransport}. Returns a scoped Effect:
 * compose with `Effect.scoped(...)` so the dispatch fiber and the
 * queue release on scope close. Exposes `webviewHandleRef`,
 * `injectedScript`, and `onMessage` for the consumer to wire to
 * `<EffectMessagingWebView>`.
 *
 * @example
 * ```ts
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const transport = yield* makeExpoTransport({
 *       bridges: [NavigationBridge, GatekeeperBridge],
 *       layers: [navLayer, gkLayer],
 *       initialMessages: [
 *         { _tag: 'HostRequestedWebNavigation', path: '/' },
 *         { _tag: 'AuthTokenIssued', token: 'abc' },
 *       ],
 *     })
 *     yield* transport.sendMessage({ _tag: 'HostBackRequested' })
 *   })
 * )
 * Effect.runPromise(program.pipe(Effect.provide(loggerLayer)))
 * ```
 */
const makeExpoTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly layers: ExpoTransportLayers<Bridges>
  readonly initialMessages: ReadonlyArray<Bridge.SendableMessage<Bridges, 'Host'>>
}): Effect.Effect<ExpoTransport<Bridges>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Mutable handle the WebView component populates via
    // `forwardRef`. `bareSender` reads it on each call; pre-mount
    // sends warn and drop.
    const webviewHandleRef: { current: WebViewHandle | null } = { current: null }

    const bareSender: BareSender = (encoded) =>
      Effect.gen(function* () {
        const handle = webviewHandleRef.current
        if (handle === null) {
          yield* Effect.logWarning(
            `[effect-messaging] sendMessage: no WebView handle yet; dropping. Pre-mount messages should ride initialMessages.`
          )
          return undefined
        }
        // RN-WebView's imperative `postMessage(string)` has a
        // different API surface from `window.postMessage` and doesn't
        // take a `targetOrigin`.
        // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
        handle.postMessage(encoded)
        return undefined
      })

    // Pre-encode the typed initial messages into a string list the
    // page side will replay via `window.__INITIAL_MESSAGES__`.
    // Reusing each bridge's `send` keeps encode parity with live
    // sends — the only difference is the {@link PlatformAdapter} we
    // provide. The capture adapter writes into a local array; the
    // live adapter (built below) is provided to
    // `BridgeTransport.make` via Layer.
    const initialEncoded: string[] = []
    const captureAdapter: PlatformAdapter['Type'] = {
      bareSender: (encoded) =>
        Effect.sync(() => {
          initialEncoded.push(encoded)
        }),
      drainInitial: Effect.succeed([]),
    }
    const captureLayer = Layer.succeed(PlatformAdapter, captureAdapter)

    // Index outbound tags to their owning bridge's `send`. The
    // function-intersection bound on the transport's public sender
    // doesn't survive structural unification at this loop, so we
    // walk the bridges' outbound schemas directly.
    type TaggedSender = (m: {
      readonly _tag: string
    }) => Effect.Effect<void, never, PlatformAdapter>
    const senderByTag = new Map<string, TaggedSender>()
    for (const bridge of config.bridges) {
      for (const tag of Object.keys(bridge.Host.OutboundSchemas)) {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        senderByTag.set(tag, bridge.Host.send as TaggedSender)
      }
    }
    for (const message of config.initialMessages) {
      // `Bridge.SendableMessage<...>` is a union that doesn't reduce
      // inside the generic body — each member has `_tag: string`, so
      // the cast just makes the invariant legible to TS.
      const tagged: { readonly _tag: string } = message
      const sender = senderByTag.get(tagged._tag)
      if (sender !== undefined) yield* sender(tagged).pipe(Effect.provide(captureLayer))
    }
    // `JSON.stringify` of the array escapes inner-encoded quotes so
    // the resulting `[...]` literal is safe to drop into a JS string
    // context.
    const injectedScript = `window.__INITIAL_MESSAGES__ = ${JSON.stringify(initialEncoded)}; true;`

    // The Expo platform doesn't attach its own listener — the
    // consumer wires `onMessage` to the WebView's `onMessage` prop.
    // We omit `attachLive`; the transport exposes `enqueue`, which
    // we expose back through `onMessage`.
    const liveAdapter: PlatformAdapter['Type'] = {
      bareSender,
      drainInitial: Effect.succeed([]),
    }

    const transport = yield* BridgeTransport.make({
      bridges: config.bridges,
      layers: config.layers,
      side: 'Host',
    }).pipe(Effect.provide(Layer.succeed(PlatformAdapter, liveAdapter)))

    const onMessage = (event: WebViewMessageEvent): void => {
      transport.enqueue(event.nativeEvent.data)
    }

    return {
      sendMessage: transport.sendMessage,
      webviewHandleRef,
      injectedScript,
      onMessage,
    }
  })

export { makeExpoTransport }
export type { ExpoTransport, ExpoTransportLayers, WebViewHandle }
