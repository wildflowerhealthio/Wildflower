import { Effect } from 'effect'
import {
  type AnyHostBinding,
  type BareSenderService,
  type BindingSend,
  type BridgesFromBindings,
  type CombinedInitialMessage,
  type ReceiverLayersFromBindings,
} from 'effect-messaging-core'
import { HostMessagingProvider } from 'effect-messaging-react'
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from 'react'
import { EffectMessagingWebView } from './effect-messaging-webview.tsx'
import { type ExpoTransport, type ExpoTransportLayers } from './transport.ts'
import { WithTransport } from './with-transport.tsx'

interface BridgedWebViewProps<Bindings extends ReadonlyArray<AnyHostBinding>> {
  /** Inline HTML the embedded SPA bundle resolves to. */
  readonly html: string
  /**
   * Logical origin the WebView resolves relative URLs against. The
   * transport encodes each binding's `initialMessages` as
   * `?<Tag>=<value>` query params on this URL; the page reads them
   * synchronously from `window.location.search` at boot.
   */
  readonly baseUrl: string
  /**
   * Ordered host bindings. Each binding pairs a bridge with its host
   * receiver layer and (optionally) initial messages plus a
   * post-transport-ready effect. The shell aggregates them into the
   * tuples `BridgeTransport.make` needs.
   */
  readonly bindings: Bindings
  /**
   * Loader element rendered on top of the WebView until its first
   * `onLoadEnd` fires. Defaults to `null`.
   */
  readonly loader?: JSX.Element
  /**
   * Subtree rendered inside the `<HostMessagingProvider>` alongside
   * the WebView. Native chrome that needs to dispatch typed messages
   * through slice host-messaging hooks belongs here.
   */
  readonly children?: ReactNode
}

/**
 * Mounts an Expo `react-native-webview` wired through an
 * {@link ExpoTransport} discharging the host receivers contributed by
 * each binding. Owns the WebView ref, aggregates `bindings` into the
 * positional tuples the transport requires, plumbs the URL-param
 * channel, exposes a `<HostMessagingProvider>` over the live transport,
 * and runs each binding's `onTransportReady` once the transport is
 * built.
 *
 * @remarks
 * Type-level: `bindings` is a heterogeneous tuple of
 * `SliceHostBinding<B_i>`. The component derives the positional
 * tuples the underlying `WithTransport` requires via three internal
 * casts — `bridges`, `layers`, and `initialMessages`. The runtime
 * mapping is provably parallel (each binding contributes one bridge
 * and one layer at the same index), so the casts are safe; they sit
 * here so callers see a single clean Bindings-shaped API.
 */
const BridgedWebView = <const Bindings extends ReadonlyArray<AnyHostBinding>>({
  html,
  baseUrl,
  bindings,
  loader,
  children,
}: BridgedWebViewProps<Bindings>): JSX.Element => {
  const webviewBareSenderRef = useRef<BareSenderService | null>(null)

  type ConcreteBridges = BridgesFromBindings<Bindings>

  // Heterogeneous tuple-map; `Array.prototype.map` widens tuple
  // positions to `T[]`, so each useMemo casts back to the parallel
  // tuple shape. The runtime mapping is provably parallel — position
  // `i`'s receiverLayer pairs with position `i`'s bridge — so the
  // casts are safe.
  const bridges = useMemo(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    () => bindings.map((b) => b.bridge) as unknown as ConcreteBridges,
    [bindings]
  )

  const layers = useMemo(
    () =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      bindings.map((b) => b.receiverLayer) as unknown as ExpoTransportLayers<ConcreteBridges> &
        ReceiverLayersFromBindings<Bindings>,
    [bindings]
  )

  const initialMessages = useMemo(() => {
    const flat = bindings.flatMap((b) => b.initialMessages ?? [])
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return flat as unknown as ReadonlyArray<CombinedInitialMessage<Bindings>>
  }, [bindings])

  return (
    <WithTransport<ConcreteBridges>
      bridges={bridges}
      layers={layers}
      initialMessages={initialMessages}
      baseUrl={baseUrl}
      webviewHandleRef={webviewBareSenderRef}
    >
      {(transport) => (
        <HostMessagingProvider bridges={bridges} sendMessage={transport.sendMessage}>
          <OnTransportReady bindings={bindings} transport={transport} />
          <EffectMessagingWebView
            ref={webviewBareSenderRef}
            source={{ html, baseUrl: transport.embedUrl }}
            onMessage={transport.onMessage}
            loader={loader}
          />
          {children}
        </HostMessagingProvider>
      )}
    </WithTransport>
  )
}

interface OnTransportReadyProps<Bindings extends ReadonlyArray<AnyHostBinding>> {
  readonly bindings: Bindings
  readonly transport: ExpoTransport<BridgesFromBindings<Bindings>>
}

/**
 * Run each binding's `onTransportReady` effect once the transport is
 * built. Lives in its own component so the `useEffect` dep array
 * captures the transport identity directly (rebuild → re-run).
 */
const OnTransportReady = <Bindings extends ReadonlyArray<AnyHostBinding>>({
  bindings,
  transport,
}: OnTransportReadyProps<Bindings>): null => {
  useEffect(() => {
    // The transport's `sendMessage` is the function-intersection over
    // every wired bridge's typed sender. Each binding receives the
    // widened single-signature `BindingSend` form — runtime dispatch
    // by `_tag` lands every message correctly; the intersection
    // subsumes the widened signature for runtime purposes.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const send = transport.sendMessage as unknown as BindingSend
    for (const binding of bindings) {
      if (binding.onTransportReady === undefined) continue
      Effect.runFork(binding.onTransportReady(send))
    }
  }, [bindings, transport])
  return null
}

export { BridgedWebView }
export type { BridgedWebViewProps }
