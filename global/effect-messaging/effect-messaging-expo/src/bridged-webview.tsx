import { Effect, Fiber, Layer } from 'effect'
import {
  type BareSenderFunction,
  type BareSenderService,
  type Bridge,
  BridgeTransport,
  HostBindings,
  TransportAdapter,
  UrlParamMessage,
} from 'effect-messaging-core'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { TransportWebView, type TransportWebViewSource } from './transport-webview.tsx'

/**
 * Where the WebView's content comes from. `uri` for a remote page;
 * `html` for inline content, with a mandatory `baseUrl` (the page's
 * logical origin — used for relative-URL resolution and as the host
 * for each binding's `initialMessages` query params).
 *
 * Shape mirrors react-native-webview's `source` prop, plus a `_tag`
 * discriminator so the consumer's intent survives the
 * initial-messages URL rewrite the transport build performs.
 */
type BridgedWebViewLoadFrom =
  | { readonly _tag: 'uri'; readonly uri: string }
  | { readonly _tag: 'html'; readonly html: string; readonly baseUrl: string }

/**
 * Props for {@link BridgedWebView}. Generic over `Bridges` so the
 * tuple shape survives into the transport build — each binding's
 * narrowly-typed sender and receiver layer keeps its position.
 *
 * See [Host Bindings Explanation](../../effect-messaging-core/docs/Host%20Bindings%20Explanation.md).
 */
interface BridgedWebViewProps<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  /**
   * Host bindings to wire into the transport — the four
   * parallel-indexed arrays produced by `HostBindings.single({...})`
   * (one slice) or `HostBindings.combine(...)` (many slices).
   *
   * **Stable identity required.** The transport is rebuilt whenever
   * the `bindings.bridges` / `bindings.receiverLayers` reference
   * changes (so the dispatch fiber, the outbound queue, and each
   * binding's `onTransportReady` re-fire). Pass a `useMemo`-ed value
   * from the calling component (or a module-level constant) — a fresh
   * literal rebuilds the transport on every render, which is almost
   * never what you want.
   */
  readonly bindings: HostBindings.HostBindings<Bridges>
  /**
   * What the WebView should load. `uri` for a remote page; `html`
   * for inline content with a mandatory `baseUrl`. The transport
   * appends each binding's `initialMessages` as `?<Tag>=<value>`
   * onto `loadFrom.uri` / `loadFrom.baseUrl` — the page reads them
   * synchronously from `window.location.search` at boot.
   *
   * Existing query strings on `loadFrom.uri` are **merged, not
   * replaced**: a caller passing `{ _tag: 'uri', uri:
   * 'https://app/?session=x' }` together with a binding emitting
   * `initialMessages: [{ _tag: 'Setup', path: '/' }]` ends up with
   * `?session=x&Setup=%2F` on the WebView source. (Same-name keys
   * coexist — `URLSearchParams` allows duplicates.)
   */
  readonly loadFrom: BridgedWebViewLoadFrom
  /** Loader rendered on top of the WebView until its first `onLoadEnd`. */
  readonly loader?: JSX.Element
  /**
   * Opt-in routing predicate forwarded to {@link TransportWebView}.
   * Return `true` to escape a URL to the system browser; omit to keep
   * every navigation in-WebView (the default).
   */
  readonly shouldOpenInSystemBrowser?: (url: string) => boolean
  /**
   * Script injected before page scripts execute. Forwarded to
   * {@link TransportWebView}. Use for pre-content shims (fetch/XHR
   * instrumentation, the browser-sniffer's injected script, etc.).
   */
  readonly injectedJavaScriptBeforeContentLoaded?: string
}

/**
 * Built transport handle. `embedUrl` carries the configured base URL
 * with each binding's `initialMessages` appended as `?<Tag>=<value>`
 * query parameters; `sendMessage` is the typed Host→Web sender;
 * `onMessage` consumes inbound message payloads and routes them
 * through the dispatch fiber.
 */
interface BuiltTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly sendMessage: BridgeTransport.MessageSender<Bridges, 'Host'>
  readonly embedUrl: string
  readonly onMessage: (raw: string) => Effect.Effect<void>
}

/**
 * Generic host shell. Builds the bridge transport on a mount-bound
 * fiber from the supplied `bindings`, stores the resulting handle in
 * local state, fires each binding's `onTransportReady` from a separate
 * effect keyed on transport identity, and renders a
 * {@link TransportWebView}.
 *
 * @remarks
 * `transport` starts `null`; while the fiber is still building it we
 * render `loader ?? null` (single render flash — no real I/O happens
 * during construction). Once the transport is set, the WebView mounts
 * and `loader` overlays it until its first `onLoadEnd` per
 * {@link TransportWebView}'s contract. Changing the
 * `bindings.bridges` / `bindings.receiverLayers` reference rebuilds
 * the transport; `loadFrom` and each binding's `initialMessages` are
 * read at build time only and don't trigger a rebuild on their own.
 *
 * @example
 * ```tsx
 * const bindings = useMemo(
 *   () => HostBindings.combine(navBindings, logBindings),
 *   [navBindings, logBindings]
 * )
 * return (
 *   <BridgedWebView
 *     bindings={bindings}
 *     loadFrom={{ _tag: 'uri', uri: 'https://app.example.com/' }}
 *     loader={<ActivityIndicator />}
 *   />
 * )
 * ```
 */
const BridgedWebView = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>({
  loadFrom,
  loader,
  bindings,
  shouldOpenInSystemBrowser,
  injectedJavaScriptBeforeContentLoaded,
}: BridgedWebViewProps<Bridges>): JSX.Element => {
  const webviewBareSenderRef = useRef<BareSenderService | null>(null)

  const [transport, setTransport] = useState<BuiltTransport<Bridges> | null>(null)

  const transportBaseUrl = loadFrom._tag === 'uri' ? loadFrom.uri : loadFrom.baseUrl

  const source = useMemo<TransportWebViewSource | null>(() => {
    if (transport === null) return null
    if (loadFrom._tag === 'html') {
      return { html: loadFrom.html, baseUrl: transport.embedUrl }
    }
    return { uri: transport.embedUrl }
  }, [loadFrom, transport])

  const { bridges, receiverLayers } = bindings

  useEffect((): undefined | (() => void) => {
    if (transport === null) return undefined
    const fiber = Effect.runFork(HostBindings.callTransportReady(bindings, transport.sendMessage))
    return (): void => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [bindings, transport])

  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          // `react-native-webview`'s imperative `postMessage(string)`
          // doesn't take a `targetOrigin`. Pre-mount sends warn and
          // drop; post-mount messages flow live to the page. Sends
          // also suspend on the page's `__Ready` post (handshake
          // gating inside `BridgeTransport.make`).
          const bareSender: BareSenderFunction = (encoded) =>
            Effect.gen(function* () {
              const handle = webviewBareSenderRef.current
              if (handle === null) {
                yield* Effect.logWarning(
                  `[effect-messaging] sendMessage: no WebView handle yet; dropping. Pre-mount messages should ride initialMessages.`
                )
                return undefined
              }
              return yield* handle.bareSender(encoded)
            })

          // The page reads `window.location.search` synchronously at
          // boot; `appendMessagesToUrl` validates each message has a
          // urlParams schema (throws on mismatch — wiring drift fails
          // fast). Flatten the parallel `initialMessages` arrays into
          // one stream before appending; TS doesn't reduce the nested
          // mapped-tuple over `Array.prototype.flat`, so we re-narrow
          // here.
          const baseUrlParsed = new URL(transportBaseUrl)
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const flatInitial = bindings.initialMessages.flat() as ReadonlyArray<
            Bridge.UrlParamableMessage<Bridges>
          >
          const embedUrl = UrlParamMessage.appendMessagesToUrl(
            baseUrlParsed,
            bridges,
            flatInitial
          ).toString()

          // The Expo platform doesn't attach its own listener — the
          // consumer wires `onMessage` to the WebView's `onMessage` prop.
          const adapter: TransportAdapter['Type'] = {
            bareSender,
            drainInitial: Effect.succeed([]),
          }

          const built = yield* BridgeTransport.make({
            bridges,
            layers: receiverLayers,
            side: 'Host',
          }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter)))

          const onMessage = (raw: string): Effect.Effect<void> => built.enqueue(raw)

          yield* Effect.sync(() =>
            setTransport({ sendMessage: built.sendMessage, embedUrl, onMessage })
          )
          yield* Effect.never
        })
      )
    )
    return (): void => {
      setTransport(null)
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // Rebuild only when the aggregated bridge/layer tuples change.
    // `initialMessages` and `transportBaseUrl` are read at build time
    // and intentionally excluded — they're seeded into the WebView's
    // URL/query at boot and can't be reapplied mid-life without a
    // remount.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [bridges, receiverLayers])

  if (transport === null || source === null) return loader ?? <></>

  return (
    <TransportWebView
      ref={webviewBareSenderRef}
      source={source}
      onMessage={(event): void => {
        // `react-native-webview`'s `onMessage` is a synchronous
        // `void` callback. `transport.onMessage` returns the queue
        // `offer` Effect; passing it through as a value (or calling
        // it inline without running) would construct the Effect and
        // drop it, silently losing every page→host message including
        // the `__Ready` handshake. A detached fork is sufficient
        // because the underlying queue is unbounded.
        Effect.runFork(transport.onMessage(event.nativeEvent.data))
      }}
      loader={loader}
      shouldOpenInSystemBrowser={shouldOpenInSystemBrowser}
      injectedJavaScriptBeforeContentLoaded={injectedJavaScriptBeforeContentLoaded}
    />
  )
}

export { BridgedWebView }
export type { BridgedWebViewLoadFrom, BridgedWebViewProps }
