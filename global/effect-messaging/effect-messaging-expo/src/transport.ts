import type { Scope } from 'effect'
import { Effect, Layer } from 'effect'
import {
  type BareSender,
  Bridge,
  BridgeTransport,
  INITIAL_MESSAGES_WINDOW_GLOBAL,
  PlatformAdapter,
} from 'effect-messaging-core'
import type { WebViewMessageEvent } from 'react-native-webview'

/**
 * Expo-side cross-process transport. Thin wrapper around the
 * platform-agnostic {@link BridgeTransport.make} core.
 *
 * @remarks
 * Supplies the Expo-specific glue:
 *
 * - **Bare sender**: the imperative `webviewHandle.postMessage` call.
 *   The consumer creates the ref and passes it to both the transport
 *   and the WebView component. Pre-mount sends warn and drop;
 *   post-mount messages flow live to the page.
 * - **Initial messages**: the consumer hands typed values; the
 *   wrapper encodes each via the matching bridge's outbound schema
 *   (using `Bridge.senderByTag` so duplicate-tag detection matches
 *   the dispatch core's policy) and assembles them into the
 *   `injectedScript` string. The page-side handler reads
 *   `window.__INITIAL_MESSAGES__` on construction and replays the
 *   strings through its own dispatch program.
 * - **Live attachment**: no platform-level listener is attached. The
 *   transport exposes an `onMessage(event)` callback the consumer
 *   wires to `<EffectMessagingWebView onMessage={...}>`.
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
 * Public Expo transport surface. The consumer wires `injectedScript`
 * and `onMessage` to the matching `<EffectMessagingWebView>` props,
 * and uses `sendMessage` to push live messages to the page after
 * mount. The consumer also creates the WebView ref and passes it to
 * both the transport (via `webviewHandleRef` config) and the
 * WebView's `ref` prop.
 */
interface ExpoTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly sendMessage: Bridge.SenderIntersection<Bridges, 'Host'>
  readonly injectedScript: string
  readonly onMessage: (event: WebViewMessageEvent) => void
}

/**
 * Construct an Expo {@link ExpoTransport}. Returns a scoped Effect:
 * compose with `Effect.scoped(...)` so the dispatch fiber and the
 * queue release on scope close.
 *
 * @example
 * ```ts
 * const webviewHandleRef: { current: WebViewHandle | null } = { current: null }
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const transport = yield* makeExpoTransport({
 *       bridges: [NavigationBridge, GatekeeperBridge],
 *       layers: [navLayer, gkLayer],
 *       initialMessages: [
 *         { _tag: 'HostRequestedWebNavigation', path: '/' },
 *         { _tag: 'AuthTokenIssued', token: 'abc' },
 *       ],
 *       webviewHandleRef,
 *     })
 *     yield* transport.sendMessage({ _tag: 'HostBackRequested' })
 *   })
 * )
 * ```
 *
 * @remarks
 * The consumer owns the `webviewHandleRef` lifecycle and passes it
 * to the WebView's `ref` prop. This keeps the transport
 * platform-implementation-agnostic and lets tests construct the
 * transport without standing up a WebView.
 */
const makeExpoTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly layers: ExpoTransportLayers<Bridges>
  readonly initialMessages: ReadonlyArray<Bridge.SendableMessage<Bridges, 'Host'>>
  readonly webviewHandleRef: { current: WebViewHandle | null }
}): Effect.Effect<ExpoTransport<Bridges>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { webviewHandleRef } = config

    const bareSender: BareSender = (encoded) =>
      Effect.gen(function* () {
        const handle = webviewHandleRef.current
        if (handle === null) {
          yield* Effect.logWarning(
            `[effect-messaging] sendMessage: no WebView handle yet; dropping. Pre-mount messages should ride initialMessages.`
          )
          return undefined
        }
        // RN-WebView's imperative `postMessage(string)` doesn't take a `targetOrigin`.
        // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
        handle.postMessage(encoded)
        return undefined
      })

    // Pre-encode the typed initial messages into a string list the
    // page side will replay via the initial-messages window global.
    // Reuses `Bridge.senderByTag` (the same helper the dispatch core
    // uses) so a cross-bridge outbound-tag collision is detected once,
    // here, instead of by drift between two ad-hoc maps.
    const initialEncoded: string[] = []
    const captureAdapter: PlatformAdapter['Type'] = {
      bareSender: (encoded) =>
        Effect.sync(() => {
          initialEncoded.push(encoded)
        }),
      drainInitial: Effect.succeed([]),
    }
    const captureLayer = Layer.succeed(PlatformAdapter, captureAdapter)
    const taggedSenders = Bridge.senderByTag(config.bridges, 'Host')
    for (const message of config.initialMessages) {
      // `Bridge.SendableMessage<...>` is a union that doesn't reduce
      // inside the generic body — every member has `_tag: string`.
      const tagged: { readonly _tag: string } = message
      const sender = taggedSenders.get(tagged._tag)
      if (sender !== undefined) yield* sender(tagged).pipe(Effect.provide(captureLayer))
    }
    // `JSON.stringify` of the array escapes inner-encoded quotes so
    // the resulting `[...]` literal is safe to drop into a JS string.
    const injectedScript = `window.${INITIAL_MESSAGES_WINDOW_GLOBAL} = ${JSON.stringify(initialEncoded)}; true;`

    // The Expo platform doesn't attach its own listener — the
    // consumer wires `onMessage` to the WebView's `onMessage` prop.
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
      injectedScript,
      onMessage,
    }
  })

export { makeExpoTransport }
export type { ExpoTransport, ExpoTransportLayers, WebViewHandle }
