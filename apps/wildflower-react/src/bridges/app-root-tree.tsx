import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import { HandlerCoordinatorContext } from 'effect-messaging-react'
import { NavigationBridgeHandler } from 'navigation-react'
import { Fragment, useMemo, type JSX, type PropsWithChildren } from 'react'
import { usePromiseOrDefault } from 'react-kitchen-sink'
import { ErrorBodyRendererContext } from 'react-tundraish'
import type { SettingsItem } from 'shared-structures-react'

import { CollectorHttpTransportProvider } from 'collector-react'

import { renderScopeError } from '../scope-error-renderer.tsx'
import { PlatformSettingsItemsProvider } from '../session/platform-settings-items.tsx'
import { stubTransport, TransportContext, type ReactTransport } from './transport-context.ts'

interface AppRootTreeProps {
  readonly router: AnyRouter
  readonly transportPromise: Promise<ReactTransport>
  /** The entry's platform-specific settings rows, provided to the tree so the
   * `/settings` route can append them. See {@link PlatformSettingsItemsProvider}. */
  readonly platformSettingsItems: readonly SettingsItem[]
  /**
   * Absolute API origin for entries whose page is not served by the API
   * server; feeds the collector's HTTP transport (its `/sniffer` REST calls
   * and `/sniffer/events` WebSocket). Omitted on web/embedded, where the page
   * IS the API origin.
   */
  readonly apiBaseUrl?: string | undefined
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
  apiBaseUrl,
}: AppRootTreeProps): JSX.Element => {
  const transport = usePromiseOrDefault(transportPromise, stubTransport, () => stubTransport)

  const InnerWrap = useMemo(
    () =>
      ({ children }: PropsWithChildren<object>): JSX.Element => (
        <Fragment>
          {/*
           * NavigationBridgeHandler only needs `transport.sendMessage`,
           * so it sits beside the collector transport provider (which is
           * HTTP-backed — the collector no longer rides the bridge).
           */}
          <NavigationBridgeHandler sender={transport.sendMessage} />
          <CollectorHttpTransportProvider apiBaseUrl={apiBaseUrl}>
            {children}
          </CollectorHttpTransportProvider>
        </Fragment>
      ),
    [transport.sendMessage, apiBaseUrl]
  )

  return (
    <ErrorBodyRendererContext.Provider value={renderScopeError}>
      <PlatformSettingsItemsProvider items={platformSettingsItems}>
        <TransportContext.Provider value={transport}>
          <HandlerCoordinatorContext.Provider value={transport.coordinator}>
            <RouterProvider router={router} InnerWrap={InnerWrap} />
          </HandlerCoordinatorContext.Provider>
        </TransportContext.Provider>
      </PlatformSettingsItemsProvider>
    </ErrorBodyRendererContext.Provider>
  )
}

export { AppRootTree }
export type { AppRootTreeProps }
