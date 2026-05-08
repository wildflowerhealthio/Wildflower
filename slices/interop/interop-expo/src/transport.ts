import type { Scope } from 'effect'
import { Effect } from 'effect'
import {
  type AnyBridge,
  type BareSender,
  type BridgeSendableMessage,
  type BridgeSenderIntersection,
  type BridgeTransportLayers,
  makeTransport,
  type PlatformAdapter,
} from 'interop-core'
import type { WebViewMessageEvent } from 'react-native-webview'

/**
 * Expo-side cross-process transport. Thin wrapper around the
 * platform-agnostic {@link makeTransport} core in `interop-core`; this
 * file supplies only the Expo-specific glue:
 *
 * - **Bare sender**: the imperative `webviewHandleRef.current.postMessage`
 *   call. Pre-mount (ref not yet populated by the WebView component) the
 *   send warns and drops; post-mount messages flow live to the page.
 * - **Initial messages**: the consumer hands typed values; the wrapper
 *   encodes each via the matching bridge's outbound schema and assembles
 *   them into the `injectedScript` string the consumer threads through
 *   `<EmbeddedWebView injectedScript={...}>`. The page-side handler
 *   reads `window.__INITIAL_MESSAGES__` on construction and replays the
 *   strings through its own dispatch program.
 * - **Live attachment**: no platform-level listener is attached. The
 *   transport exposes an `onMessage(event)` callback the consumer wires
 *   to `<EmbeddedWebView onMessage={...}>`; that callback enqueues the
 *   raw string into the dispatch fiber.
 *
 * The dispatch core (handler resolution, tag-collision detection,
 * decode-then-route fiber, error formatting) lives in
 * `interop-core/transport`; tests for that pipeline live there too.
 */

/** Tuple-positional layer requirement for the Native side of every wired bridge. */
type ExpoTransportLayers<Bridges extends ReadonlyArray<AnyBridge>> = BridgeTransportLayers<
  Bridges,
  'Native'
>

/** Imperative handle the WebView component populates via `forwardRef`. */
interface WebViewHandle {
  postMessage(data: string): void
}

/**
 * Public Expo transport surface. The consumer wires `webviewHandleRef`
 * to `<EmbeddedWebView ref={...}>`, `injectedScript` to
 * `injectedScript`, and `onMessage` to `onMessage`. `sendMessage` is
 * the typed Effect-returning sender the consumer uses to push messages
 * to the page after mount.
 */
interface ExpoTransport<Bridges extends ReadonlyArray<AnyBridge>> {
  readonly sendMessage: BridgeSenderIntersection<Bridges, 'Native'>
  readonly webviewHandleRef: { current: WebViewHandle | null }
  readonly injectedScript: string
  readonly onMessage: (event: WebViewMessageEvent) => void
}

/**
 * Construct an Expo {@link ExpoTransport}. Returns a scoped Effect:
 * compose with `Effect.scoped(...)` so the dispatch fiber and the
 * queue release on scope close. Exposes `webviewHandleRef`,
 * `injectedScript`, and `onMessage` for the consumer to wire to
 * `<EmbeddedWebView>`.
 *
 * Usage:
 *
 * ```ts
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const transport = yield* makeExpoTransport({
 *       bridges: [NavigationBridge, GatekeeperBridge],
 *       layers: [navLayer, gkLayer],
 *       initialMessages: [
 *         { _tag: 'NativeRequestedWebNavigation', path: '/' },
 *         { _tag: 'AuthTokenIssued', token: 'abc' },
 *       ],
 *     })
 *     yield* transport.sendMessage({ _tag: 'NativeBackRequested' })
 *   })
 * )
 * Effect.runPromise(program.pipe(Effect.provide(loggerLayer)))
 * ```
 */
const makeExpoTransport = <const Bridges extends ReadonlyArray<AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly layers: ExpoTransportLayers<Bridges>
  readonly initialMessages: ReadonlyArray<BridgeSendableMessage<Bridges, 'Native'>>
}): Effect.Effect<ExpoTransport<Bridges>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Mutable handle the WebView component populates via `forwardRef`.
    // `bareSender` reads it on each call; pre-mount sends warn and drop.
    const webviewHandleRef: { current: WebViewHandle | null } = { current: null }

    const bareSender: BareSender = (encoded) =>
      Effect.gen(function* () {
        const handle = webviewHandleRef.current
        if (handle === null) {
          yield* Effect.logWarning(
            `[interop] sendMessage: no WebView handle yet; dropping. Pre-mount messages should ride initialMessages.`
          )
          return undefined
        }
        // RN-WebView's imperative `postMessage(string)` has a different
        // API surface from `window.postMessage` and doesn't take a
        // `targetOrigin`.
        // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
        handle.postMessage(encoded)
        return undefined
      })

    // Pre-encode the typed initial messages into a string list the page
    // side will replay via `window.__INITIAL_MESSAGES__`. We re-use each
    // bridge's `makeSender` with a capturing sink — same encode path the
    // live `bareSender` follows, just diverted into a list.
    const initialEncoded: string[] = []
    const captureSender: BareSender = (encoded) =>
      Effect.sync(() => {
        initialEncoded.push(encoded)
      })

    // Map each outbound tag to its bridge's capturing sender, mirroring
    // the index `makeTransport` builds for live sends. Cross-bridge
    // outbound-tag collisions are caught here and again inside
    // `makeTransport`; we don't pre-empt that check.
    type CapturingSender = (m: { readonly _tag: string }) => Effect.Effect<void>
    const capturingSenderByTag = new Map<string, CapturingSender>()
    for (const bridge of config.bridges) {
      const sender = bridge.Native.makeSender(captureSender)
      for (const tag of Object.keys(bridge.Native.OutboundSchemas)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        capturingSenderByTag.set(tag, sender as CapturingSender)
      }
    }
    for (const message of config.initialMessages) {
      // The `BridgeSendableMessage<...>` union doesn't reduce inside
      // the generic body, so TS can't see the structural `_tag`
      // invariant here. Each union member is a tagged-struct decoded
      // type, so the property access is safe; the cast just makes it
      // legible to the type system.
      const tagged: { readonly _tag: string } = message
      const sender = capturingSenderByTag.get(tagged._tag)
      if (sender !== undefined) yield* sender(tagged)
    }
    // `JSON.stringify` of the array escapes inner-encoded quotes so the
    // resulting `[...]` literal is safe to drop into a JS string
    // context.
    const injectedScript = `window.__INITIAL_MESSAGES__ = ${JSON.stringify(initialEncoded)}; true;`

    // The Expo platform doesn't attach its own listener — the consumer
    // wires `onMessage` to the WebView's `onMessage` prop. We omit
    // `attachLive`; the transport exposes `enqueue`, which we expose
    // back through `onMessage`.
    const adapter: PlatformAdapter = {
      bareSender,
      drainInitial: Effect.succeed([]),
    }

    const transport = yield* makeTransport({
      bridges: config.bridges,
      layers: config.layers,
      side: 'Native',
      adapter,
    })

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
