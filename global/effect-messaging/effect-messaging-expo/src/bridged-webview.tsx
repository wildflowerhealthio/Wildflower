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
import { flattenTuples } from 'kitchen-sink/types'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useComponentScopedRunner } from 'react-kitchen-sink'
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
   * replaced**: a caller passing
   * `{ _tag: 'uri', uri: 'https://app/?session=x' }` together with
   * a binding emitting
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
 * through the dispatch fiber. `setLayers` swaps the active receiver
 * layers without rebuilding the transport (see
 * {@link BridgeTransport.BridgeTransport.setLayers}).
 */
interface BuiltTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly sendMessage: BridgeTransport.MessageSender<Bridges, 'Host'>
  readonly embedUrl: string
  readonly onMessage: (raw: string) => Effect.Effect<void>
  readonly setLayers: (layers: Bridge.TransportLayers<Bridges, 'Host'>) => Effect.Effect<void>
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
  // Stable ref to the current receiver layers so the (build-once)
  // buildEffect closure captures the initial value while the
  // layer-sync effect below can still observe React-render reference
  // flips and call `setLayers`. Without the ref, the buildEffect's
  // `useMemo([bridges])` would freeze whichever receiverLayers it
  // first saw, and a later sibling-binding flip during the build
  // window would never make it into the transport.
  const initialReceiverLayersRef = useRef(receiverLayers)
  const initialBindingsRef = useRef(bindings)

  const transportReadyEffect = useMemo(() => {
    if (transport === null) return Effect.void

    return HostBindings.callTransportReady(bindings, transport.sendMessage)
  }, [bindings, transport])

  useComponentScopedRunner(transportReadyEffect)

  // Reset to the loader on the rare `bridges` change. With the
  // post-mount `setLayers` path below, `receiverLayers` flips no
  // longer tear down the transport — only a bridges-set change
  // (slice added/removed) forces a rebuild, since the schema union
  // and outbound sender map are bridges-derived.
  useEffect(
    () => (): void => {
      setTransport(null)
    },
    [bridges]
  )

  const buildEffect = useMemo(
    () =>
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
          // fast). `flattenTuples` (kitchen-sink) collapses the
          // parallel `initialMessages` mapped-tuple into one flat
          // sequence while preserving the union over `Bridges`, so no
          // cast is needed. `initialBindingsRef.current` carries the
          // freshest `initialMessages` tuple at build time — usually
          // the first-render value, but if a sibling binding flipped
          // between mount and this build firing, we pick up the
          // newer URL-seeded payloads.
          const baseUrlParsed = new URL(transportBaseUrl)
          const flatInitial = flattenTuples(initialBindingsRef.current.initialMessages)
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
            layers: initialReceiverLayersRef.current,
            side: 'Host',
          }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter)))

          const onMessage = (raw: string): Effect.Effect<void> => built.enqueue(raw)

          yield* Effect.sync(() =>
            setTransport({
              sendMessage: built.sendMessage,
              embedUrl,
              onMessage,
              setLayers: built.setLayers,
            })
          )
          // Park the fiber until `useComponentScopedRunner`'s cleanup
          // interrupts it — closing the scope tears down
          // `BridgeTransport.make`'s dispatch fiber + outbound queue.
          yield* Effect.never
        })
      ),
    // Bridges-keyed only. `initialMessages` / `transportBaseUrl` /
    // `receiverLayers` are intentionally excluded: the first two
    // are URL-baked at build time and can't be reapplied mid-life
    // without a remount; the third flows through `setLayers` (the
    // sync effect below) so the transport stays alive across
    // sibling-binding rerenders.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [bridges]
  )

  useComponentScopedRunner(buildEffect)

  // Layer sync: when `receiverLayers` reference flips (typically a
  // sibling binding re-rendering — token arrival, modal state, etc.),
  // discharge the new layers into the existing transport's handler
  // Ref via `setLayers`. The dispatch fiber, queue, schema union,
  // and `peerReady` Deferred all persist; only the per-bridge
  // handler map swaps. Bypasses the loader entirely — the WebView
  // never unmounts.
  useEffect(() => {
    if (transport === null) return undefined
    // Skip the initial render: the first `receiverLayers` value is
    // already baked into the transport via `BridgeTransport.make`'s
    // initial-layers arg above.
    if (receiverLayers === initialReceiverLayersRef.current) return undefined
    const fiber = Effect.runFork(transport.setLayers(receiverLayers))
    return (): void => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [receiverLayers, transport])

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
