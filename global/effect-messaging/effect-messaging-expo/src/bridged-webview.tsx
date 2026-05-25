import { Effect, Fiber } from 'effect'
import { type BareSenderService, HostBinding } from 'effect-messaging-core'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { TransportWebView, type TransportWebViewSource } from './transport-webview.tsx'
import { type ExpoTransport, makeExpoTransport } from './transport.ts'

/**
 * Where the WebView's content comes from. `uri` for a remote page;
 * `html` for inline content, with a mandatory `baseUrl` (the page's
 * logical origin — used for relative-URL resolution and as the host
 * for each binding's `initialMessages` query params).
 *
 * Shape mirrors react-native-webview's `source` prop, plus a `_tag`
 * discriminator so the consumer's intent survives the
 * initial-messages URL rewrite the transport performs.
 */
type BridgedWebViewLoadFrom =
  | { readonly _tag: 'uri'; readonly uri: string }
  | { readonly _tag: 'html'; readonly html: string; readonly baseUrl: string }

/**
 * Props for {@link BridgedWebView}. Generic over `TBindings` so the
 * tuple shape survives into `HostBinding.aggregate` and the
 * transport — each binding's narrowly-typed sender and receiver layer
 * keeps its position.
 *
 * See [Host Bindings Explanation](../../effect-messaging-core/docs/Host%20Bindings%20Explanation.md).
 */
interface BridgedWebViewProps<TBindings extends ReadonlyArray<HostBinding.Any>> {
  /**
   * Tuple of host bindings to wire into the transport.
   *
   * **Stable identity required.** The transport is rebuilt whenever
   * the `bindings` reference changes (so the dispatch fiber, the
   * outbound queue, and each binding's `onTransportReady` re-fire).
   * Pass a `useMemo`-ed tuple from the calling component (or a
   * module-level constant) — a fresh literal on every render rebuilds
   * the transport on every render, which is almost never what you
   * want. Each binding's `receiverLayer` and any
   * `onTransportReady` callback is captured at build time; later
   * mutations to those fields are observed only by the next rebuild.
   */
  readonly bindings: TBindings
  /**
   * What the WebView should load. `uri` for a remote page; `html`
   * for inline content with a mandatory `baseUrl`. The transport
   * appends each binding's `initialMessages` as `?<Tag>=<value>`
   * onto `loadFrom.uri` / `loadFrom.baseUrl` — the page reads them
   * synchronously from `window.location.search` at boot.
   */
  readonly loadFrom: BridgedWebViewLoadFrom
  /** Loader rendered on top of the WebView until its first `onLoadEnd`. */
  readonly loader?: JSX.Element
  /**
   * Override default navigation routing. See {@link TransportWebView}
   * for full semantics — supplying a predicate replaces the
   * same-origin gate entirely.
   */
  readonly shouldHandleInWebView?: (url: string) => boolean
  /**
   * Script injected before page scripts execute. Forwarded to
   * {@link TransportWebView}. Use for pre-content shims (fetch/XHR
   * instrumentation, the browser-sniffer's injected script, etc.).
   */
  readonly injectedJavaScriptBeforeContentLoaded?: string
}

/**
 * Generic host shell. Aggregates `bindings` via
 * {@link HostBinding.aggregate}, builds the transport via
 * {@link makeExpoTransport} on a mount-bound fiber
 * (`Effect.runFork`/`Fiber.interrupt`, matching `AppRuntimeProvider`'s
 * lifecycle pattern), stores it in local state, fires each binding's
 * `onTransportReady` from a separate effect keyed on transport
 * identity, and renders a {@link TransportWebView}.
 *
 * @remarks
 * `transport` starts `null`; while the fiber is still building it we
 * render `loader ?? null` (single render flash — `makeExpoTransport`
 * performs no real I/O during construction). Once the transport is
 * set, the WebView mounts and `loader` overlays it until its first
 * `onLoadEnd` per {@link TransportWebView}'s contract. Changing the
 * `bindings` reference rebuilds the transport; `loadFrom` and each
 * binding's `initialMessages` are read at build time only and don't
 * trigger a rebuild on their own.
 *
 * @example
 * ```tsx
 * const bindings = useMemo(
 *   () => [navBinding, logBinding] as const,
 *   [navBinding, logBinding]
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
const BridgedWebView = <const TBindings extends ReadonlyArray<HostBinding.Any>>({
  loadFrom,
  loader,
  bindings,
  shouldHandleInWebView,
  injectedJavaScriptBeforeContentLoaded,
}: BridgedWebViewProps<TBindings>): JSX.Element => {
  const { bridges, layers, initialMessages } = useMemo(
    () => HostBinding.aggregate(bindings),
    [bindings]
  )

  const webviewBareSenderRef = useRef<BareSenderService | null>(null)

  const [transport, setTransport] = useState<ExpoTransport<
    HostBinding.BridgesOf<TBindings>
  > | null>(null)

  // The URL the transport rewrites with `initialMessages` query
  // params. For `uri` sources the WebView loads the rewritten URL
  // directly; for `html` sources the rewritten URL becomes the page's
  // `baseUrl` (so `window.location.search` carries the params even
  // though the page content is inline).
  const transportBaseUrl = loadFrom._tag === 'uri' ? loadFrom.uri : loadFrom.baseUrl

  const source = useMemo<TransportWebViewSource | null>(() => {
    if (transport === null) return null
    if (loadFrom._tag === 'html') {
      return { html: loadFrom.html, baseUrl: transport.embedUrl }
    }
    return { uri: transport.embedUrl }
  }, [loadFrom, transport])

  useEffect((): undefined | (() => void) => {
    if (transport === null) return undefined
    const fiber = Effect.runFork(HostBinding.callTransportReady(bindings, transport.sendMessage))
    return (): void => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [bindings, transport])

  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const built = yield* makeExpoTransport({
            bridges,
            layers,
            initialMessages,
            baseUrl: transportBaseUrl,
            webviewHandleRef: webviewBareSenderRef,
          })
          yield* Effect.sync(() => setTransport(built))
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
  }, [bridges, layers])

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
        Effect.runFork(transport.onMessage(event))
      }}
      loader={loader}
      shouldHandleInWebView={shouldHandleInWebView}
      injectedJavaScriptBeforeContentLoaded={injectedJavaScriptBeforeContentLoaded}
    />
  )
}

export { BridgedWebView }
export type { BridgedWebViewLoadFrom, BridgedWebViewProps }
