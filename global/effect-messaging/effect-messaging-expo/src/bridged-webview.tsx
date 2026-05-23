import { Effect, Fiber, Match } from 'effect'
import { type BareSenderService, HostBinding } from 'effect-messaging-core'
import {
  HostMessagingProvider,
  useRegisterHostSender,
  type HostSenderFn,
} from 'effect-messaging-react'
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  EffectMessagingWebView,
  type EffectMessagingWebViewSource,
} from './effect-messaging-webview.tsx'
import { type ExpoTransport, makeExpoTransport } from './transport.ts'

/**
 * Props for {@link BridgedWebView}. `bindings` is generic over its
 * tuple shape so `HostBinding.aggregate` can preserve positional
 * typing into the transport.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md).
 */
interface BridgedWebViewProps<Bindings extends ReadonlyArray<HostBinding.Any>> {
  readonly loadFrom: { readonly _tag: 'html'; readonly html: string } | { readonly _tag: 'uri' }
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
 * via {@link HostBinding.aggregate}, runs the transport's scope on a
 * mount-bound fiber (mirroring `AppRuntimeProvider`'s
 * `useEffect`/`runFork`/`Fiber.interrupt` pattern), provides
 * `<HostMessagingProvider>`, renders the WebView followed by
 * `belowWebView`, and runs each binding's `onTransportReady` via
 * {@link TransportReadyCaller}.
 *
 * @remarks
 * `transport` is held in local state and starts `null`; while the
 * fiber is still building the transport we render `loader ?? null`
 * (single render flash — `makeExpoTransport` performs no real I/O
 * during construction). Once the transport is set, the WebView and
 * provider mount and `loader` overlays the WebView until its first
 * `onLoadEnd` per `EffectMessagingWebView`'s contract.
 */
const BridgedWebView = <const Bindings extends ReadonlyArray<HostBinding.Any>>({
  loadFrom,
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

  const [transport, setTransport] = useState<ExpoTransport<HostBinding.BridgesOf<Bindings>> | null>(
    null
  )

  const source = useMemo(
    () =>
      transport === null
        ? null
        : Match.value(loadFrom).pipe(
            Match.withReturnType<EffectMessagingWebViewSource>(),
            Match.tag('html', ({ html }) => ({ html, baseUrl: transport.embedUrl })),
            Match.tag('uri', () => ({ uri: transport.embedUrl })),
            Match.exhaustive
          ),
    [loadFrom, transport]
  )

  // Publish the transport's host sender into the nearest
  // `<HoistedHostMessagingProvider>` ref slot (if one is mounted above).
  // Lets sibling React trees — e.g. a sibling Stack screen that mounts
  // *outside* the WebView's own subtree — send through the same
  // transport via `useXxxHostMessaging`. No-op when no hoisted provider
  // is in the ancestry; the inner `<HostMessagingProvider>` below still
  // serves descendants of this component.
  //
  // The transport's typed function-intersection `sendMessage` widens to
  // the single-signature `HostSenderFn` the ref slot stores — same
  // widen pattern used inside `HostMessagingProvider` itself.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const widenedSender = (transport?.sendMessage ?? null) as unknown as HostSenderFn | null
  useRegisterHostSender(widenedSender)

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
    <HostMessagingProvider bridges={bridges} sendMessage={transport.sendMessage}>
      <TransportReadyCaller bindings={bindings} transport={transport} />
      <SafeAreaView
        edges={{ bottom: 'off', top: 'additive', left: 'additive', right: 'additive' }}
        style={{ flex: 1 }}
      >
        <EffectMessagingWebView
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
    </HostMessagingProvider>
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
