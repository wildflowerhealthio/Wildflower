import type { Effect } from 'effect'
import { type BridgeTransport, HostBindings } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'
import { useMemo } from 'react'
import { makeNavigationHostHandlers } from './host-receiver-layer.ts'

interface UseNavigationHostBindingOptions {
  /** Initial SPA route; seeded via the URL-param channel. */
  readonly initialRoute?: string
  /** Fires when the SPA emits `RouteChanged`. */
  readonly onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void
  /**
   * Fires once when the SPA emits `UIReady` (auth gate passed + startup
   * prefetches settled). The host hides the native splash / reveals the
   * WebView here. Callers must stabilise this themselves — it's in the
   * memo's dep list.
   */
  readonly onUiReady?: () => void
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
 * Host binding for the navigation bridge. Combines the handler record
 * with an optional `HostRequestedWebNavigation` initial message, and
 * surfaces the transport's typed sender via `onTransportReady` so a
 * sibling consumer (e.g. a native tab bar) can dispatch through it.
 *
 * @remarks
 * Callers must stabilise `onRouteChanged` themselves (e.g. with
 * `useCallback`) — it's in the memo's dep list, and an unstable
 * reference re-runs `HostBindings.combine` and rebuilds the WebView
 * transport on every host render.
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
  onUiReady,
  onTransportReady,
}: UseNavigationHostBindingOptions = {}): HostBindings.HostBindings<
  readonly [typeof NavigationBridge]
> =>
  useMemo(
    () =>
      HostBindings.single({
        bridge: NavigationBridge,
        handlers: makeNavigationHostHandlers(onRouteChanged, onUiReady),
        initialMessages:
          initialRoute === undefined
            ? undefined
            : [{ _tag: 'HostRequestedWebNavigation' as const, path: initialRoute }],
        onTransportReady,
      }),
    [initialRoute, onRouteChanged, onUiReady, onTransportReady]
  )

export { useNavigationHostBinding }
export type { UseNavigationHostBindingOptions }
