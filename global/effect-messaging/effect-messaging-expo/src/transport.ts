import type { Scope } from 'effect'
import { Effect, Layer } from 'effect'
import {
  type Bridge,
  type BareSenderFunction,
  BridgeTransport,
  TransportAdapter,
  UrlParamMessage,
  type BareSenderService,
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
 *   post-mount messages flow live to the page. Sends suspend until
 *   the page posts `__Ready` (handshake gating in the dispatch core).
 * - **Initial messages**: the consumer hands typed values whose tags
 *   have a `urlParams` schema declared on their owning bridge; the
 *   wrapper encodes each via that schema and appends them as
 *   `?<Tag>=<value>` query parameters on the WebView's `baseUrl`.
 *   Empty values render as bare flags (`?<Tag>` without `=`). The page
 *   reads them synchronously from `window.location.search` at boot.
 * - **Live attachment**: no platform-level listener is attached. The
 *   transport exposes an `onMessage(event)` callback the consumer
 *   wires to `<TransportWebView onMessage={...}>`.
 */

/** Tuple-positional layer requirement for the Host side of every wired bridge. */
type ExpoTransportLayers<Bridges extends ReadonlyArray<Bridge.AnyBridge>> = Bridge.TransportLayers<
  Bridges,
  'Host'
>

/**
 * Public Expo transport surface. The consumer wires `embedUrl` into
 * the WebView's `source` (as `{ uri }` for remote pages, or as the
 * `baseUrl` of `{ html, baseUrl }` for inline content) and
 * `onMessage` to the WebView's `onMessage` prop. `sendMessage`
 * suspends until the page posts `__Ready`. The consumer also creates
 * the WebView ref and passes it to both the transport (via
 * `webviewHandleRef`) and the WebView's `ref` prop.
 */
interface ExpoTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly sendMessage: BridgeTransport.MessageSender<Bridges, 'Host'>
  /**
   * The configured `baseUrl` with one `?<Tag>=<value>` param per
   * typed initial message. Empty values render as bare flags.
   */
  readonly embedUrl: string
  readonly onMessage: (event: WebViewMessageEvent) => Effect.Effect<void, never, never>
}

/**
 * Construct an Expo {@link ExpoTransport}. Returns a scoped Effect:
 * compose with `Effect.scoped(...)` so the dispatch fiber and the
 * queue release on scope close.
 *
 * @example
 * ```ts
 * const webviewHandleRef: { current: BareSenderService | null } = { current: null }
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const transport = yield* makeExpoTransport({
 *       bridges: [NavigationBridge, GatekeeperBridge],
 *       layers: [navLayer, gkLayer],
 *       initialMessages: [
 *         { _tag: 'HostRequestedWebNavigation', path: '/' },
 *         { _tag: 'AuthTokenIssued', token: 'abc' },
 *       ],
 *       baseUrl: 'https://app.local/',
 *       webviewHandleRef,
 *     })
 *     // <TransportWebView source={{ html, baseUrl: transport.embedUrl }} ... />
 *     yield* transport.sendMessage({ _tag: 'HostBackRequested' })
 *   })
 * )
 * ```
 *
 * @remarks
 * `initialMessages` is narrowed to `UrlParamableMessage` — the type
 * system rejects any tag whose owning bridge has no `urlParams`
 * schema declared. The consumer owns the `webviewHandleRef`
 * lifecycle and passes it to the WebView's `ref` prop.
 */
const makeExpoTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly layers: ExpoTransportLayers<Bridges>
  readonly initialMessages: ReadonlyArray<Bridge.UrlParamableMessage<Bridges>>
  readonly baseUrl: string
  readonly webviewHandleRef: { readonly current: BareSenderService | null }
}): Effect.Effect<ExpoTransport<Bridges>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { webviewHandleRef } = config

    const bareSender: BareSenderFunction = (encoded) =>
      Effect.gen(function* () {
        const handle = webviewHandleRef.current
        if (handle === null) {
          yield* Effect.logWarning(
            `[effect-messaging] sendMessage: no WebView handle yet; dropping. Pre-mount messages should ride initialMessages.`
          )
          return undefined
        }
        // RN-WebView's imperative `postMessage(string)` doesn't take a `targetOrigin`.
        return yield* handle.bareSender(encoded)
      })

    // The page reads `window.location.search` synchronously at boot;
    // `appendMessagesToUrl` validates each message has a urlParams
    // schema (throws on mismatch — wiring drift fails fast).
    const baseUrlParsed = new URL(config.baseUrl)
    const embedUrl = UrlParamMessage.appendMessagesToUrl(
      baseUrlParsed,
      config.bridges,
      config.initialMessages
    ).toString()

    // The Expo platform doesn't attach its own listener — the
    // consumer wires `onMessage` to the WebView's `onMessage` prop.
    const liveAdapter: TransportAdapter['Type'] = {
      bareSender,
      drainInitial: Effect.succeed([]),
    }

    const transport = yield* BridgeTransport.make({
      bridges: config.bridges,
      layers: config.layers,
      side: 'Host',
    }).pipe(Effect.provide(Layer.succeed(TransportAdapter, liveAdapter)))

    const onMessage = (event: WebViewMessageEvent): Effect.Effect<void, never, never> =>
      transport.enqueue(event.nativeEvent.data)

    return {
      sendMessage: transport.sendMessage,
      embedUrl,
      onMessage,
    }
  })

export { makeExpoTransport }
export type { ExpoTransport, ExpoTransportLayers }
