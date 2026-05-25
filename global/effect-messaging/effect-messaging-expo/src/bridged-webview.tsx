import { Effect, Fiber, Match } from 'effect'
import { type BareSenderService, HostBinding } from 'effect-messaging-core'
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { SafeAreaView } from 'react-native-safe-area-context'
import { TransportWebView, type TransportWebViewSource } from './transport-webview.tsx'
import { type ExpoTransport, makeExpoTransport } from './transport.ts'

/**
 * Props for {@link BridgedWebView}. Generic over `TBindings` so the
 * tuple shape survives into `HostBinding.aggregate` and the transport
 * — each binding's narrowly-typed sender and receiver layer keeps its
 * position.
 *
 * See [Host Bindings Explanation](../../effect-messaging-core/docs/Host%20Bindings%20Explanation.md).
 */
interface BridgedWebViewProps<TBindings extends ReadonlyArray<HostBinding.Any>> {
  /** Tuple of host bindings to wire into the transport. */
  readonly bindings: TBindings
  /**
   * Slice-side dispatch registry provider mounted around the WebView.
   * Typically the `Provider` produced by `makeBridgeDispatcher`; any
   * children-rendering component works for non-slice consumers.
   */
  readonly BridgeDispatchRegistryProvider: React.FC<React.PropsWithChildren>
  readonly loadFrom: { readonly _tag: 'html'; readonly html: string } | { readonly _tag: 'uri' }
  /**
   * Logical origin the WebView resolves relative URLs against; the
   * transport encodes each binding's `initialMessages` as
   * `?<Tag>=<value>` query params on it.
   */
  readonly baseUrl: string
  /** Loader rendered on top of the WebView until its first `onLoadEnd`. */
  readonly loader?: JSX.Element
  /**
   * Content rendered immediately below the WebView, inside the
   * `<BridgeDispatchRegistryProvider>`. Typically a native tab bar whose press
   * handlers dispatch typed messages via slice host-messaging hooks.
   */
  readonly belowWebView?: ReactNode
}

/**
 * Generic host shell. Aggregates `bindings` via
 * {@link HostBinding.aggregate} (memoized so the derived tuples stay
 * reference-stable across renders), builds the transport via
 * {@link makeExpoTransport} on a mount-bound fiber
 * (`Effect.runFork`/`Fiber.interrupt`, matching `AppRuntimeProvider`'s
 * lifecycle pattern), stores it in local state, fires each binding's
 * `onTransportReady` from a separate effect keyed on transport
 * identity, and renders the WebView wrapped in
 * `<BridgeDispatchRegistryProvider>`.
 *
 * @remarks
 * `transport` starts `null`; while the fiber is still building it we
 * render `loader ?? null` (single render flash — `makeExpoTransport`
 * performs no real I/O during construction). Once the transport is
 * set, the WebView and provider mount and `loader` overlays the
 * WebView until its first `onLoadEnd` per `TransportWebView`'s
 * contract. Changing the `bindings` reference rebuilds the transport;
 * `baseUrl` and each binding's `initialMessages` are read at build
 * time only and don't trigger a rebuild on their own.
 */
const BridgedWebView = <const TBindings extends ReadonlyArray<HostBinding.Any>>({
  loadFrom,
  baseUrl,
  loader,
  belowWebView,
  bindings,
  BridgeDispatchRegistryProvider,
}: BridgedWebViewProps<TBindings>): JSX.Element => {
  const { bridges, layers, initialMessages } = useMemo(
    () => HostBinding.aggregate(bindings),
    [bindings]
  )

  const webviewBareSenderRef = useRef<BareSenderService | null>(null)

  const [transport, setTransport] = useState<ExpoTransport<
    HostBinding.BridgesOf<TBindings>
  > | null>(null)

  const source = useMemo(
    () =>
      transport === null
        ? null
        : Match.value(loadFrom).pipe(
            Match.withReturnType<TransportWebViewSource>(),
            Match.tag('html', ({ html }) => ({ html, baseUrl: transport.embedUrl })),
            Match.tag('uri', () => ({ uri: transport.embedUrl })),
            Match.exhaustive
          ),
    [loadFrom, transport]
  )

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
            baseUrl,
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
    // `initialMessages` and `baseUrl` are read at build time and
    // intentionally excluded — they're seeded into the WebView's
    // URL/query at boot and can't be reapplied mid-life without a
    // remount.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [bridges, layers])

  if (transport === null || source === null) return loader ?? <></>

  return (
    <BridgeDispatchRegistryProvider>
      <SafeAreaView
        edges={{ bottom: 'off', top: 'additive', left: 'additive', right: 'additive' }}
        style={{ flex: 1 }}
      >
        <TransportWebView
          ref={webviewBareSenderRef}
          source={source}
          onMessage={(event): void => {
            // `react-native-webview`'s `onMessage` is a synchronous
            // `void` callback. `transport.onMessage` returns the queue
            // `offer` Effect; passing it through as a value (or
            // calling it inline without running) would construct the
            // Effect and drop it, silently losing every page→host
            // message including the `__Ready` handshake. A detached
            // fork is sufficient because the underlying queue is
            // unbounded.
            Effect.runFork(transport.onMessage(event))
          }}
          loader={loader}
        />
        {belowWebView}
      </SafeAreaView>
    </BridgeDispatchRegistryProvider>
  )
}

export { BridgedWebView }
export type { BridgedWebViewProps }
