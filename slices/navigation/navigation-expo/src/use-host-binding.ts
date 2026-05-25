import type { Effect } from 'effect'
import type { HostBinding } from 'effect-messaging-core'
import { NavigationBridge } from 'navigation-core'
import { useMemo } from 'react'
import { type LogMessage, ReceiverLayer } from './host-receiver-layer.ts'

interface UseNavigationHostBindingOptions {
  /** Initial SPA route; seeded via the URL-param channel. */
  readonly initialRoute?: string
  /** Fires when the SPA emits `RouteChanged`. */
  readonly onRouteChanged?: (route: { pathname: string; canGoBack: boolean }) => void
  /** Escape hatch for SPA-side `Log` messages. Defaults to `Effect.log<Level>(...payload)`. */
  readonly onLog?: (log: LogMessage) => Effect.Effect<void>
}

/**
 * Host binding for the navigation bridge. Combines the receiver layer
 * with an optional `HostRequestedWebNavigation` initial message.
 */
const useNavigationHostBinding = ({
  initialRoute,
  onRouteChanged,
  onLog,
}: UseNavigationHostBindingOptions = {}): HostBinding.HostBinding<typeof NavigationBridge> =>
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
