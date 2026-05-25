import { Effect, Fiber, Match } from 'effect'
import { type BareSenderService, HostBinding } from 'effect-messaging-core'
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { SafeAreaView } from 'react-native-safe-area-context'
import { TransportWebView, type TransportWebViewSource } from './transport-webview.tsx'
import { type ExpoTransport, makeExpoTransport } from './transport.ts'

/**
 * Props for {@link BridgedWebView}. `bindings` is generic over its
 * tuple shape so `HostBinding.aggregate` can preserve positional
 * typing into the transport.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md).
 */
interface BridgedWebViewProps {
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
 * The generic host shell. Owns the WebView ref, aggregates `bindings`
 * via {@link HostBinding.aggregate}, runs the transport's scope on a
 * mount-bound fiber (mirroring `AppRuntimeProvider`'s
 * `useEffect`/`runFork`/`Fiber.interrupt` pattern), provides
 * `<BridgeDispatchRegistryProvider>`, renders the WebView followed by
 * `belowWebView`, and runs each binding's `onTransportReady` via
 * {@link TransportReadyCaller}.
 *
 * @remarks
 * `transport` is held in local state and starts `null`; while the
 * fiber is still building the transport we render `loader ?? null`
 * (single render flash — `makeExpoTransport` performs no real I/O
 * during construction). Once the transport is set, the WebView and
 * provider mount and `loader` overlays the WebView until its first
 * `onLoadEnd` per `TransportWebView`'s contract.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
const makeBridgedWebView = <const Bindings extends ReadonlyArray<HostBinding.Any>>(
  bindings: Bindings,
  BridgeDispatchRegistryProvider: React.FC<React.PropsWithChildren>
): React.FC<BridgedWebViewProps> => {
  const { bridges, layers, initialMessages } = HostBinding.aggregate(bindings)

  return ({ loadFrom, baseUrl, loader, belowWebView }: BridgedWebViewProps): JSX.Element => {
    const webviewBareSenderRef = useRef<BareSenderService | null>(null)

    const [transport, setTransport] = useState<ExpoTransport<
      HostBinding.BridgesOf<Bindings>
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

    useTransportReadyCaller({ bindings, transport })

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
      // Only re-run if the `bridge or its handlers change
      // initialMessages and baseUrl ONLY matter at startup
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
              // `react-native-webview`'s `onMessage` is a sync `void` callback —
              // passing `transport.onMessage` directly would construct an Effect
              // per inbound message and discard it, silently dropping every
              // page→host message including the `__Ready` handshake.
              // `transport.enqueue` is `Queue.offer` on an unbounded queue, so a
              // detached fork is sufficient.
              Effect.runFork(transport.onMessage(event))
            }}
            loader={loader}
          />
          {belowWebView}
        </SafeAreaView>
      </BridgeDispatchRegistryProvider>
    )
  }
}
interface TransportReadyCallerProps<Bindings extends ReadonlyArray<HostBinding.Any>> {
  readonly bindings: Bindings
  readonly transport: ExpoTransport<HostBinding.BridgesOf<Bindings>> | null
}

/**
 * Calls each binding's `onTransportReady` once the transport is built.
 * Isolated from {@link BridgedWebView}'s render so the `useEffect` dep
 * array can key directly on the transport identity.
 */
const useTransportReadyCaller = <Bindings extends ReadonlyArray<HostBinding.Any>>({
  bindings,
  transport,
}: TransportReadyCallerProps<Bindings>): JSX.Element => {
  useEffect(() => {
    if (transport === null) return
    // The transport's `sendMessage` is the function-intersection over
    // every bridge's typed sender; widen it to the single-signature
    // `BindingSend` so each binding's narrowly-typed `onTransportReady`
    // can receive it. Runtime dispatch by `_tag` lands every message
    // correctly.
    const send = transport.sendMessage
    HostBinding.callTransportReady(bindings, send)
  }, [bindings, transport])
  return <></>
}

export { makeBridgedWebView }
export type { BridgedWebViewProps }
