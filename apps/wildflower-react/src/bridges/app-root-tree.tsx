import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import { HandlerCoordinatorContext } from 'effect-messaging-react'
import { NavigationBridgeHandler } from 'navigation-react'
import { Fragment, useMemo, type JSX, type PropsWithChildren } from 'react'
import { usePromiseOrDefault } from 'react-kitchen-sink'
import { ErrorBodyRendererContext } from 'react-tundraish'
import type { SettingsItem } from 'shared-structures-react'

import { renderScopeError } from '../scope-error-renderer.tsx'
import { PlatformSettingsItemsProvider } from '../session/platform-settings-items.tsx'
import { PlatformTabsProvider } from '../session/platform-tabs.tsx'
import type { TabSpec } from '../session/tabs.ts'
import { CollectorSenderForwarder } from './collector-sender-forwarder.tsx'
import { HarRecorderSenderForwarder } from './har-recorder-sender-forwarder.tsx'
import { stubTransport, TransportContext, type ReactTransport } from './transport-context.ts'

interface AppRootTreeProps {
  readonly router: AnyRouter
  readonly transportPromise: Promise<ReactTransport>
  /** The entry's platform-specific settings rows, provided to the tree so the
   * `/settings` route can append them. See {@link PlatformSettingsItemsProvider}. */
  readonly platformSettingsItems: readonly SettingsItem[]
  /** The entry's platform-specific tabs, provided to the tree so the primary
   * bar can render them after the shared ones. See {@link PlatformTabsProvider}. */
  readonly platformTabs: readonly TabSpec[]
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
  platformTabs,
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
          <CollectorSenderForwarder>
            <HarRecorderSenderForwarder>{children}</HarRecorderSenderForwarder>
          </CollectorSenderForwarder>
        </Fragment>
      ),
    [transport.sendMessage]
  )

  return (
    <ErrorBodyRendererContext.Provider value={renderScopeError}>
      <PlatformSettingsItemsProvider items={platformSettingsItems}>
        <PlatformTabsProvider tabs={platformTabs}>
          <TransportContext.Provider value={transport}>
            <HandlerCoordinatorContext.Provider value={transport.coordinator}>
              <RouterProvider router={router} InnerWrap={InnerWrap} />
            </HandlerCoordinatorContext.Provider>
          </TransportContext.Provider>
        </PlatformTabsProvider>
      </PlatformSettingsItemsProvider>
    </ErrorBodyRendererContext.Provider>
  )
}

export { AppRootTree }
export type { AppRootTreeProps }
