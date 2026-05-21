import { type BareSenderService, HostBinding } from 'effect-messaging-core'
import { HostMessagingProvider } from 'effect-messaging-react'
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from 'react'
import { EffectMessagingWebView } from './effect-messaging-webview.tsx'
import type { ExpoTransport } from './transport.ts'
import { WithTransport } from './with-transport.tsx'

/**
 * Props for {@link BridgedWebView}. `bindings` is generic over its
 * tuple shape so `HostBinding.aggregate` can preserve positional
 * typing into `WithTransport`.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md).
 */
interface BridgedWebViewProps<Bindings extends ReadonlyArray<HostBinding.Any>> {
  /** Inline HTML the embedded SPA bundle resolves to. */
  readonly html: string
  /**
   * Logical origin the WebView resolves relative URLs against; the
   * transport encodes each binding's `initialMessages` as
   * `?<Tag>=<value>` query params on it.
   */
  readonly baseUrl: string
  /** Ordered host bindings — one per wired bridge. */
  readonly bindings: Bindings
  /** Loader rendered on top of the WebView until its first `onLoadEnd`. */
  readonly loader?: JSX.Element
  /**
   * Content rendered immediately below the WebView, inside the
   * `<HostMessagingProvider>`. Typically a native tab bar whose press
   * handlers dispatch typed messages via slice host-messaging hooks.
   */
  readonly belowWebView?: ReactNode
}

/**
 * The generic host shell. Owns the WebView ref, aggregates `bindings`
 * via {@link HostBinding.aggregate}, mounts the transport, provides
 * `<HostMessagingProvider>`, renders the WebView followed by
 * `belowWebView`, and runs each binding's `onTransportReady` via
 * {@link TransportReadyCaller}.
 */
const BridgedWebView = <const Bindings extends ReadonlyArray<HostBinding.Any>>({
  html,
  baseUrl,
  bindings,
  loader,
  belowWebView,
}: BridgedWebViewProps<Bindings>): JSX.Element => {
  const webviewBareSenderRef = useRef<BareSenderService | null>(null)

  const { bridges, layers, initialMessages } = useMemo(
    () => HostBinding.aggregate(bindings),
    [bindings]
  )

  return (
    <WithTransport<HostBinding.BridgesOf<Bindings>>
      bridges={bridges}
      layers={layers}
      initialMessages={initialMessages}
      baseUrl={baseUrl}
      webviewHandleRef={webviewBareSenderRef}
    >
      {(transport) => (
        <HostMessagingProvider bridges={bridges} sendMessage={transport.sendMessage}>
          <TransportReadyCaller bindings={bindings} transport={transport} />
          <EffectMessagingWebView
            ref={webviewBareSenderRef}
            source={{ html, baseUrl: transport.embedUrl }}
            onMessage={transport.onMessage}
            loader={loader}
          />
          {belowWebView}
        </HostMessagingProvider>
      )}
    </WithTransport>
  )
}

interface TransportReadyCallerProps<Bindings extends ReadonlyArray<HostBinding.Any>> {
  readonly bindings: Bindings
  readonly transport: ExpoTransport<HostBinding.BridgesOf<Bindings>>
}

/**
 * Calls each binding's `onTransportReady` once the transport is built.
 * Isolated from {@link BridgedWebView}'s render so the `useEffect` dep
 * array can key directly on the transport identity.
 */
const TransportReadyCaller = <Bindings extends ReadonlyArray<HostBinding.Any>>({
  bindings,
  transport,
}: TransportReadyCallerProps<Bindings>): null => {
  useEffect(() => {
    // The transport's `sendMessage` is the function-intersection over
    // every bridge's typed sender; widen it to the single-signature
    // `BindingSend` so each binding's narrowly-typed `onTransportReady`
    // can receive it. Runtime dispatch by `_tag` lands every message
    // correctly.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const send = transport.sendMessage as unknown as HostBinding.BindingSend
    HostBinding.callTransportReady(bindings, send)
  }, [bindings, transport])
  return null
}

export { BridgedWebView }
export type { BridgedWebViewProps }
