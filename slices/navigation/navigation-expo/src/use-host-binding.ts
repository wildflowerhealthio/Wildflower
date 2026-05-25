import type { HostBinding } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'
import { useMemo } from 'react'
import { ReceiverLayer } from './host-receiver-layer.ts'

interface UseNavigationHostBindingOptions {
  /** Initial SPA route; seeded via the URL-param channel. */
  readonly initialRoute?: string
  /** Fires when the SPA emits `RouteChanged`. */
  readonly onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void
}

/**
 * Host binding for the navigation bridge. Combines the receiver layer
 * with an optional `HostRequestedWebNavigation` initial message.
 *
 * @remarks
 * Callers must stabilise `onRouteChanged` themselves (e.g. with
 * `useCallback`) — it's in the memo's dep list, and an unstable
 * reference re-runs `BridgedWebView`'s `HostBinding.aggregate` and
 * rebuilds the WebView transport on every host render.
 *
 * Cross-process `Log` mirroring used to ride this binding via an
 * `onLog` option; it's now on the shared `LogBridge` (compose
 * `useLogHostBinding()` from `effect-messaging-expo` alongside).
 *
 * @example
 * ```tsx
 * const onRouteChanged = useCallback((r) => setRoute(r), [setRoute])
 * const binding = NavigationBridgeExpo.useHostBinding({ initialRoute, onRouteChanged })
 * ```
 */
const useNavigationHostBinding = ({
  initialRoute,
  onRouteChanged,
}: UseNavigationHostBindingOptions = {}): HostBinding.HostBinding<typeof NavigationBridge> =>
  useMemo(
    () => ({
      bridge: NavigationBridge,
      receiverLayer: ReceiverLayer(onRouteChanged),
      initialMessages:
        initialRoute === undefined
          ? undefined
          : [{ _tag: 'HostRequestedWebNavigation' as const, path: initialRoute }],
    }),
    [initialRoute, onRouteChanged]
  )

export { useNavigationHostBinding }
export type { UseNavigationHostBindingOptions }
