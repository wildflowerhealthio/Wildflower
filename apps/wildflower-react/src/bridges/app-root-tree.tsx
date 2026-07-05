import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import { HandlerCoordinatorContext } from 'effect-messaging-react'
import { NavigationBridgeHandler } from 'navigation-react'
import { Fragment, useMemo, type JSX, type PropsWithChildren } from 'react'
import { usePromiseOrDefault } from 'react-kitchen-sink'
import type { SettingsItem } from 'shared-structures-react'

import { PlatformSettingsItemsProvider } from '../session/platform-settings-items.tsx'
import { CollectorSenderForwarder } from './collector-sender-forwarder.tsx'
import { stubTransport, TransportContext, type ReactTransport } from './transport-context.ts'

interface AppRootTreeProps {
  readonly router: AnyRouter
  readonly transportPromise: Promise<ReactTransport>
  /** The entry's platform-specific settings rows, provided to the tree so the
   * `/settings` route can append them. See {@link PlatformSettingsItemsProvider}. */
  readonly platformSettingsItems: readonly SettingsItem[]
}

/**
 * Owns the `transport` state seeded by `transportPromise`. Until the
 * promise resolves, `TransportContext` holds the `stubTransport`
 * (no-op sender) so the sender-forwarders below render without
 * crashing. The `_auth` gate's `awaitAuthReady` waits the bridge
 * handshake before any consumer that needs a *real* sender renders, so
 * the brief stub window has no live subscribers other than the
 * navigation watcher.
 *
 * `NavigationBridgeHandler` is rendered unconditionally — it observes
 * `useLocation()` and emits `RouteChanged` through the current
 * transport's `sendMessage`.
 */
const AppRootTree = ({
  router,
  transportPromise,
  platformSettingsItems,
}: AppRootTreeProps): JSX.Element => {
  const transport = usePromiseOrDefault(transportPromise, stubTransport, () => stubTransport)

  const InnerWrap = useMemo(
    () =>
      ({ children }: PropsWithChildren<object>): JSX.Element => (
        <Fragment>
          {/*
           * NavigationBridgeHandler only needs `transport.sendMessage`
           * (not the slice sender), so it sits beside the forwarder
           * rather than buried inside it.
           */}
          <NavigationBridgeHandler sender={transport.sendMessage} />
          <CollectorSenderForwarder>{children}</CollectorSenderForwarder>
        </Fragment>
      ),
    [transport.sendMessage]
  )

  return (
    <PlatformSettingsItemsProvider items={platformSettingsItems}>
      <TransportContext.Provider value={transport}>
        <HandlerCoordinatorContext.Provider value={transport.coordinator}>
          <RouterProvider router={router} InnerWrap={InnerWrap} />
        </HandlerCoordinatorContext.Provider>
      </TransportContext.Provider>
    </PlatformSettingsItemsProvider>
  )
}

export { AppRootTree }
export type { AppRootTreeProps }
