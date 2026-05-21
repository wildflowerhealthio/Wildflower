import type { Effect } from 'effect'
import type { SliceHostBinding } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'
import { useMemo } from 'react'
import { ReceiverLayer } from './host-receiver-layer.ts'

interface UseNavigationHostBindingOptions {
  /**
   * Initial SPA route to seed via the URL-param channel. Encoded as
   * `?HostRequestedWebNavigation=<path>` on the WebView's source URL,
   * so the page reads it synchronously at boot before the live
   * transport connects.
   */
  readonly initialRoute?: string
  /**
   * Fired when the SPA emits `RouteChanged`. Hosts use this to drive
   * native chrome (tab highlight, back chevron, splash reveal).
   */
  readonly onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void
  /**
   * Escape hatch for SPA-side `Log` messages. Defaults to
   * `Effect.log`, mirroring the historical inline behaviour.
   */
  readonly onLog?: (log: string) => Effect.Effect<void>
}

/**
 * Build a {@link SliceHostBinding} for the navigation bridge. Combines
 * the host receiver layer (route-changed + log handlers) with an
 * optional `HostRequestedWebNavigation` initial message that seeds
 * the SPA's first route via the URL-param channel.
 *
 * Stable across renders as long as the option callbacks are stable.
 * Memoize callbacks (`useCallback`) at the call site to avoid
 * rebuilding the binding tuple on every render.
 */
const useNavigationHostBinding = ({
  initialRoute,
  onRouteChanged,
  onLog,
}: UseNavigationHostBindingOptions = {}): SliceHostBinding<typeof NavigationBridge> =>
  useMemo(
    () => ({
      bridge: NavigationBridge,
      receiverLayer: ReceiverLayer(onRouteChanged, onLog),
      initialMessages:
        initialRoute === undefined
          ? undefined
          : [{ _tag: 'HostRequestedWebNavigation' as const, path: initialRoute }],
    }),
    [initialRoute, onRouteChanged, onLog]
  )

export { useNavigationHostBinding }
export type { UseNavigationHostBindingOptions }
