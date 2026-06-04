import { Deferred, Effect, Layer, Queue, Stream } from 'effect'
import {
  type BareSenderFunction,
  type Bridge,
  BridgeTransport,
  HostBindings,
  TransportAdapter,
  UrlParamMessage,
} from 'effect-messaging-core'
import { flattenTuples } from 'kitchen-sink/types'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
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
   * the `bindings.bridges` reference changes (so the dispatch fiber and
   * the two queues are torn down and rebuilt). A `bindings.handlers`
   * reference flip swaps the active handler records in place via
   * `registerHandlers` — no rebuild. `bindings.onPageReady` is sampled
   * fresh on every `__Ready` the host receives (see {@link HostBindings.callPageReady}),
   * so token / route / state pushes ride the live transport across
   * WebView reloads without remounting. Pass a `useMemo`-ed value from
   * the calling component (or a module-level constant) — a fresh
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
  readonly sendMessage: BridgeTransport.MessageSender<Bridges, 'HostToWeb'>
  readonly onMessage: (raw: string) => Effect.Effect<void>
  readonly registerHandlers: (
    handlers: Bridge.HandlersByBridge<Bridges, 'WebToHost'>
  ) => Effect.Effect<void, BridgeTransport.DuplicateTagError>
}

/**
 * Generic host shell. Computes the WebView's URL synchronously and
 * mounts a {@link TransportWebView} on the first render — under the
 * host's native splash — so the page starts downloading immediately
 * while the bridge transport builds on a mount-bound fiber in parallel.
 * The built transport is stashed in a ref (nothing in render depends on
 * it). Each binding's `onPageReady` fires inside the transport's inbound
 * dispatcher every time the page posts `__Ready` (so the first load and
 * every subsequent reload re-deliver each slice's initial-state push),
 * and a `bindings.handlers` flip swaps the live handler records through
 * `registerHandlers` without a rebuild.
 *
 * @remarks
 * There is no JS loader gate: the WebView is in the tree from the start
 * and the app shell lets the native splash cover the load, hiding it on
 * the page's UI-ready signal. Changing the `bindings.bridges`
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
  // imperative handle. Lazy `useState` initialiser runs once per mount
  // (running `Deferred.make` only allocates) so the ref callback — which
  // fires during commit, before the build fiber runs — has something to
  // resolve.
  const [bareSenderDeferred] = useState(() => Effect.runSync(Deferred.make<BareSenderFunction>()))

  // Inbox-of-inbox for page→host messages. The `<WebView>` can fire its
  // `onMessage` prop the moment the page is parsed, but the host
  // transport (which owns the real inbox) is built later inside
  // `buildEffect`'s forked fiber. Without an upstream buffer, the page's
  // very first message — `__Ready` — drops with the
  // `onMessage before transport built` warning, the gate stays closed
  // forever, and every `HostToWeb` push (auth token, route, …) sits
  // buffered with no peer to drain it. Buffering here means every
  // page→host message is conserved regardless of build timing: the
  // `onMessage` handler offers synchronously (`Queue.unbounded` never
  // blocks on offer) and the build fiber forks a single-consumer drain
  // that forwards in FIFO order into `built.enqueue`. The queue itself
  // is never shut down — the lazy `useState` initialiser runs once per
  // mount and the queue is GC'd with the component; only the
  // `forkScoped` drain is interrupted on scope close (see the drain
  // comment below).
  const [pendingQueue] = useState(() => Effect.runSync(Queue.unbounded<string>()))

  const bareSenderRefCallback = useCallback(
    (bareSender: BareSenderFunction | null): void => {
      if (bareSender === null) return
      // First attach resolves the Deferred so the build fiber's awaiting
      // bareSender wakes up. `Deferred.succeed` returns `false` if the
      // Deferred was already resolved — a same-instance re-attach is a
      // benign no-op, but a *different* WebView instance attaching (e.g.
      // a future remount that keeps the host shell mounted) would silently
      // send into the void since the original sender is captured. Surface
      // that case loudly via the Effect logger instead of dropping silently.
      const wasFirstAttach = Effect.runSync(
        Deferred.succeed(bareSenderDeferred, (encoded) => bareSender(encoded))
      )
      if (!wasFirstAttach) {
        Effect.runFork(
          Effect.logWarning(
            '[effect-messaging] BridgedWebView bareSender ref re-attached after first resolve; subsequent sends still route to the original WebView handle.'
          )
        )
      }
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
        // Refresh the frozen-first-render snapshot at the top of every
        // build (initial mount AND every bridges rebuild) so the seeded
        // `handlers`, the `onPageReady` calls fired by the transport,
        // and the `registerHandlers` skip-check in the sibling
        // `useEffect` all observe the *current* bindings — not the ones
        // captured at first mount. Reading from the closure-captured
        // `bindings` (refreshed by the `[bridges]` `useMemo` recompute)
        // is the freshness contract; this assignment just propagates it.
        yield* Effect.sync(() => {
          initialBindingsRef.current = bindings
        })

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

        // Read off the frozen first-render snapshot inside `onPageReady`
        // — `bindings` is stable for the lifetime of this build, but
        // `bindings.onPageReady` is a fresh array per
        // `HostBindings.combine` call upstream. Routing through the ref
        // keeps the per-render closures honest *if* the consumer ever
        // does flip onPageReady identity mid-life (today's bindings
        // memoise their slot, but the transport guarantee shouldn't
        // depend on that).
        const built = yield* BridgeTransport.makeHostTransport({
          bridges,
          handlers: bindings.handlers,
          onPageReady: (send) => HostBindings.callPageReady(initialBindingsRef.current, send),
        }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter)))

        yield* Effect.sync(() => {
          transportRef.current = {
            sendMessage: built.sendMessage,
            onMessage: (raw) => built.enqueue(raw),
            registerHandlers: built.registerHandlers,
          }
        })

        // Diagnostic: surface how many messages were buffered before
        // the transport caught up, so the boot timeline is visible in
        // logs without resorting to a debugger. Zero is the steady
        // state once the build is fast enough; a non-zero count tells
        // us the `__Ready` (and anything behind it) arrived early and
        // is about to drain into the dispatcher.
        const initialBuffered = yield* Queue.size(pendingQueue)
        if (initialBuffered > 0) {
          yield* Effect.logInfo(
            `[effect-messaging] BridgedWebView transport built; draining ${initialBuffered} pre-build page→host message(s) into inbox`
          )
        }

        // Single-consumer drain: forwards every queued page→host raw
        // string into the transport's inbox. Forked into the build
        // scope so it's interrupted on scope close. The queue itself
        // intentionally outlives this scope — if `bindings.bridges`
        // ever changes (against this component's stable-identity
        // contract), the old scope's interrupt would stop this drain
        // and the new `buildEffect` would fork a fresh one against
        // the same queue, so in-flight pre-build offers survive a
        // transport rebuild. The queue is held in a `useState` slot and
        // GC'd with the component; `Queue.unbounded` holds no
        // off-heap resources, so there's nothing to release on unmount
        // beyond memory.
        yield* Effect.forkScoped(
          Stream.runForEach(Stream.fromQueue(pendingQueue), (raw) => built.enqueue(raw))
        )

        // Park until `useComponentScopedRunner`'s cleanup interrupts —
        // closing the scope tears down both queues and both fibers.
        // The transport fires every binding's `onPageReady` itself,
        // synchronously inside its `__Ready` control handler, so the
        // first page load and every subsequent reload re-deliver each
        // slice's initial-state push without anything to drive from here.
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
    // The build effect closure captures `bindings` fresh on every
    // bridges-change recompute, so reading `bindings.handlers` /
    // `bindings` directly inside the gen body picks up the current
    // values rather than the frozen first-render snapshot.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [bridges]
  )

  useComponentScopedRunner(buildEffect)

  // Handler sync: when `handlers` reference flips (typically a sibling
  // binding re-rendering — token arrival, modal state, etc.), route the
  // new records through `registerHandlers` — a single `Ref.set` that swaps
  // the active map atomically against the dispatch fiber. The two queues,
  // both fibers, the schema union, and `peerReadyGate` all persist; a message
  // that arrives with no covering handler is logged-and-dropped.
  useEffect(() => {
    // Skip the initial render: the first `handlers` value is already
    // baked into the transport via `BridgeTransport.makeHostTransport`'s initial arg.
    if (handlers === initialBindingsRef.current.handlers) return undefined
    const transport = transportRef.current
    if (transport === null) return undefined
    Effect.runFork(
      // Surface the typed `DuplicateTagError` from `registerHandlers` to
      // the Effect logger so a runtime wiring collision doesn't vanish
      // behind the default forked-fiber unhandled-error reporter.
      transport
        .registerHandlers(handlers)
        .pipe(
          Effect.catchAll((error) =>
            Effect.logError('BridgedWebView: handler registration failed', error)
          )
        )
    )
    return undefined
  }, [handlers])

  return (
    <TransportWebView
      ref={bareSenderRefCallback}
      source={source}
      onMessage={(event): void => {
        // `react-native-webview`'s `onMessage` is a synchronous `void`
        // callback. Offer to the upstream buffer queue rather than
        // straight to `transportRef.current.onMessage` — the WebView
        // can fire this callback before the build fiber has finished
        // constructing the transport, and dropping `__Ready` there
        // silently breaks the entire handshake. The drain stream
        // forked at the end of `buildEffect` is the single FIFO
        // consumer that forwards every offer into the transport's
        // inbox; pre-build offers stack until the transport exists.
        // `Queue.unbounded`'s `offer` never suspends and `runSync`
        // evaluates it inline. The queue is never shut down (only GC'd
        // with the component), so `offer` always succeeds; a late offer
        // racing scope teardown is harmless because the WebView child
        // unmounts with this component, so `onMessage` can't fire once
        // the queue is gone.
        Effect.runSync(Queue.offer(pendingQueue, event.nativeEvent.data))
      }}
      shouldOpenInSystemBrowser={shouldOpenInSystemBrowser}
      injectedJavaScriptBeforeContentLoaded={injectedJavaScriptBeforeContentLoaded}
    />
  )
}

export { BridgedWebView }
export type { BridgedWebViewLoadFrom, BridgedWebViewProps }
