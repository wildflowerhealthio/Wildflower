import type { Effect } from 'effect'
import type { BridgeTransport, HostBinding } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'
import { useMemo } from 'react'
import { ReceiverLayer } from './host-receiver-layer.ts'

interface UseNavigationHostBindingOptions {
  /** Initial SPA route; seeded via the URL-param channel. */
  readonly initialRoute?: string
  /** Fires when the SPA emits `RouteChanged`. */
  readonly onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void
  /**
   * Invoked once the WebView transport has built. Receives the typed
   * sender for outbound navigation messages; the host shell typically
   * captures it so a sibling tab bar can dispatch into the same
   * transport.
   */
  readonly onTransportReady?: (
    send: BridgeTransport.MessageSender<readonly [typeof NavigationBridge], 'Host'>
  ) => Effect.Effect<void>
}

/**
 * Host binding for the navigation bridge. Combines the receiver layer
 * with an optional `HostRequestedWebNavigation` initial message, and
 * surfaces the transport's typed sender via `onTransportReady` so a
 * sibling consumer (e.g. a native tab bar) can dispatch through it.
 *
 * @remarks
 * Callers must stabilise `onRouteChanged` and `onTransportReady`
 * themselves (e.g. with `useCallback`) — both sit in the memo's dep
 * list, and an unstable reference re-runs `BridgedWebView`'s
 * `HostBinding.aggregate` and rebuilds the WebView transport on every
 * host render.
 *
 * Cross-process `Log` mirroring used to ride this binding via an
 * `onLog` option; it's now on the shared `LogBridge` (compose
 * `useLogHostBinding()` from `effect-messaging-expo` alongside).
 *
 * @example
 * ```tsx
 * const onRouteChanged = useCallback((r) => setRoute(r), [setRoute])
 * const onTransportReady = useCallback(
 *   (send) => Effect.sync(() => setNavigationSender(send)),
 *   [setNavigationSender]
 * )
 * const binding = NavigationBridgeExpo.useHostBinding({
 *   initialRoute,
 *   onRouteChanged,
 *   onTransportReady,
 * })
 * ```
 */
const useNavigationHostBinding = ({
  initialRoute,
  onRouteChanged,
  onTransportReady,
}: UseNavigationHostBindingOptions = {}): HostBinding.HostBinding<typeof NavigationBridge> =>
  useMemo(
    () => ({
      bridge: NavigationBridge,
      receiverLayer: ReceiverLayer(onRouteChanged),
      initialMessages:
        initialRoute === undefined
          ? undefined
          : [{ _tag: 'HostRequestedWebNavigation' as const, path: initialRoute }],
      ...(onTransportReady === undefined ? {} : { onTransportReady }),
    }),
    [initialRoute, onRouteChanged, onTransportReady]
  )

export { useNavigationHostBinding }
export type { UseNavigationHostBindingOptions }
