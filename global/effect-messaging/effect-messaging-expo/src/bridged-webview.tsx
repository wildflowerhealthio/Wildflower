import { Deferred, Effect, Layer } from 'effect'
import {
  type BareSenderFunction,
  type Bridge,
  BridgeTransport,
  HostBindings,
  TransportAdapter,
  UrlParamMessage,
} from 'effect-messaging-core'
import { flattenTuples } from 'kitchen-sink/types'
import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react'
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
 * narrowly-typed sender and inbound handler record keeps its position.
 *
 * See [Host Bindings Explanation](../../effect-messaging-core/docs/Host%20Bindings%20Explanation.md).
 */
interface BridgedWebViewProps<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  /**
   * Host bindings to wire into the transport — the four
   * parallel-indexed arrays produced by `HostBindings.single({...})`
   * (one slice) or `HostBindings.combine(...)` (many slices).
   *
   * **Stable identity required.** The transport is rebuilt only when
   * the `bindings.bridges` reference changes (so the dispatch fiber,
   * the two queues, and each binding's `onTransportReady` re-fire). A
   * `bindings.handlers` reference flip swaps the active handler records
   * in place via `registerHandlers` — no rebuild. Pass a `useMemo`-ed
   * value from the calling component (or a module-level constant) — a
   * fresh literal rebuilds the transport on every render, which is
   * almost never what you want.
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
 * Built transport handle, stashed in a ref once the build fiber
 * resolves. `sendMessage` is the typed Host→Web sender; `onMessage`
 * pushes an inbound payload into the dispatch fiber's inbox;
 * `registerHandlers` swaps the active handler records without
 * rebuilding the transport (see
 * {@link BridgeTransport.BridgeTransport.registerHandlers}).
 */
interface BuiltTransport<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly sendMessage: BridgeTransport.MessageSender<Bridges, 'Host'>
  readonly onMessage: (raw: string) => Effect.Effect<void>
  readonly registerHandlers: (
    handlers: Bridge.HandlersByBridge<Bridges, 'Host'>
  ) => Effect.Effect<void>
}

/**
 * Generic host shell. Computes the WebView's URL synchronously and
 * mounts a {@link TransportWebView} on the first render — under the
 * host's native splash — so the page starts downloading immediately
 * while the bridge transport builds on a mount-bound fiber in parallel.
 * The built transport is stashed in a ref (nothing in render depends on
 * it), each binding's `onTransportReady` fires from the same build
 * fiber, and a `bindings.handlers` flip swaps the live handler records
 * through `registerHandlers` without a rebuild.
 *
 * @remarks
 * There is no JS loader gate: the WebView is in the tree from the start.
 * Hosts that want a covering placeholder during page load pass `loader`
 * (overlaid by {@link TransportWebView} until its first `onLoadEnd`);
 * the app shell instead lets the native splash cover the load and hides
 * it on the page's UI-ready signal. Changing the `bindings.bridges`
 * reference tears down and rebuilds the transport; `loadFrom` and each
 * binding's `initialMessages` are URL-baked at first render and don't
 * trigger a rebuild on their own.
 *
 * @example
 * ```tsx
 * const bindings = useMemo(
 *   () => HostBindings.combine([navBindings, logBindings]),
 *   [navBindings, logBindings]
 * )
 * return (
 *   <BridgedWebView
 *     bindings={bindings}
 *     loadFrom={{ _tag: 'uri', uri: 'https://app.example.com/' }}
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
  const { bridges, handlers } = bindings

  const transportRef = useRef<BuiltTransport<Bridges> | null>(null)

  // First-render bindings, frozen. `initialMessages` are URL-baked once
  // and `handlers` seed the transport's initial handler map; a later
  // sibling-binding flip is reconciled by the `registerHandlers` effect
  // below, never by re-reading this ref.
  const initialBindingsRef = useRef(bindings)

  // Bare-sender handle as a Deferred the build fiber's adapter awaits,
  // so a host→web send never observes a missing WebView. Resolved by
  // the WebView ref callback once react-native-webview attaches its
  // imperative handle. Created eagerly (running `Deferred.make` only
  // allocates) so the ref callback — which fires during commit, before
  // the build fiber runs — has something to resolve.
  const bareSenderDeferredRef = useRef<Deferred.Deferred<BareSenderFunction> | null>(null)
  if (bareSenderDeferredRef.current === null) {
    bareSenderDeferredRef.current = Effect.runSync(Deferred.make<BareSenderFunction>())
  }
  const bareSenderDeferred = bareSenderDeferredRef.current

  const bareSenderRefCallback = useCallback(
    (bareSender: BareSenderFunction | null): void => {
      if (bareSender === null) return
      // Idempotent: a re-attach (same WebView instance) re-succeeds a
      // resolved Deferred, which is a no-op.
      Effect.runSync(Deferred.succeed(bareSenderDeferred, (encoded) => bareSender(encoded)))
    },
    [bareSenderDeferred]
  )

  const transportBaseUrl = loadFrom._tag === 'uri' ? loadFrom.uri : loadFrom.baseUrl

  // Synchronous so the WebView mounts on the first render. The page
  // reads `window.location.search` at boot; `appendMessagesToUrl`
  // validates each message has a urlParams schema (throws on mismatch —
  // wiring drift fails fast). `flattenTuples` collapses the parallel
  // `initialMessages` mapped-tuple into one flat sequence while
  // preserving the union over `Bridges`, so no cast is needed. Read off
  // the frozen first-render bindings: the URL can't be re-seeded
  // mid-life without a remount.
  const embedUrl = useMemo(() => {
    const flatInitial = flattenTuples(initialBindingsRef.current.initialMessages)
    return UrlParamMessage.appendMessagesToUrl(
      new URL(transportBaseUrl),
      bridges,
      flatInitial
    ).toString()
  }, [bridges, transportBaseUrl])

  const source = useMemo<TransportWebViewSource>(
    () =>
      loadFrom._tag === 'html' ? { html: loadFrom.html, baseUrl: embedUrl } : { uri: embedUrl },
    [loadFrom, embedUrl]
  )

  const buildEffect = useMemo(
    () =>
      Effect.gen(function* () {
        // `react-native-webview`'s imperative `postMessage(string)`
        // doesn't take a `targetOrigin`. Awaiting the Deferred blocks
        // the send until the WebView handle exists; sends also gate on
        // the page's `__Ready` post inside the transport's outbox pump.
        const bareSender: BareSenderFunction = (encoded) =>
          Deferred.await(bareSenderDeferred).pipe(Effect.flatMap((send) => send(encoded)))

        // The Expo platform doesn't attach its own listener — the
        // consumer wires `onMessage` to the WebView's `onMessage` prop.
        const adapter: TransportAdapter['Type'] = {
          bareSender,
          drainInitial: Effect.succeed([]),
        }

        const built = yield* BridgeTransport.make({
          bridges,
          handlers: initialBindingsRef.current.handlers,
          side: 'Host',
        }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter)))

        yield* Effect.sync(() => {
          transportRef.current = {
            sendMessage: built.sendMessage,
            onMessage: (raw) => built.enqueue(raw),
            registerHandlers: built.registerHandlers,
          }
        })

        // Fire each binding's `onTransportReady` once the transport
        // exists; the sender identity is stable for its lifetime, so a
        // single firing (re-fired only on a bridges rebuild) is correct.
        yield* HostBindings.callTransportReady(initialBindingsRef.current, built.sendMessage)

        // Park until `useComponentScopedRunner`'s cleanup interrupts —
        // closing the scope tears down both queues and both fibers.
        yield* Effect.never
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            transportRef.current = null
          })
        )
      ),
    // Bridges-keyed only. `initialMessages` / `transportBaseUrl` are
    // URL-baked at build time and can't be reapplied mid-life without a
    // remount; `handlers` flow through `registerHandlers` (the sync
    // effect below) so the transport survives sibling-binding rerenders.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [bridges]
  )

  useComponentScopedRunner(buildEffect)

  // Handler sync: when `handlers` reference flips (typically a sibling
  // binding re-rendering — token arrival, modal state, etc.), route the
  // new records through `registerHandlers` — a single `Ref.set` that swaps
  // the active map atomically against the dispatch fiber. The two queues,
  // both fibers, the schema union, and `peerReady` all persist; a message
  // that arrives with no covering handler is logged-and-dropped.
  useEffect(() => {
    // Skip the initial render: the first `handlers` value is already
    // baked into the transport via `BridgeTransport.make`'s initial arg.
    if (handlers === initialBindingsRef.current.handlers) return undefined
    const transport = transportRef.current
    if (transport === null) return undefined
    Effect.runFork(transport.registerHandlers(handlers))
    return undefined
  }, [handlers])

  return (
    <TransportWebView
      ref={bareSenderRefCallback}
      source={source}
      onMessage={(event): void => {
        // `react-native-webview`'s `onMessage` is a synchronous `void`
        // callback. `transport.onMessage` returns the inbox `offer`
        // Effect; running it inline as a value would construct and drop
        // it, silently losing every page→host message including the
        // `__Ready` handshake. A detached fork suffices (the inbox is
        // unbounded). The transport is built well before the page can
        // post (its bundle has to load first), so the null branch is a
        // loud guard rather than an expected path.
        const transport = transportRef.current
        if (transport === null) {
          Effect.runFork(
            Effect.logWarning(
              `[effect-messaging] onMessage before transport built; dropping "${event.nativeEvent.data}".`
            )
          )
          return
        }
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
