import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import { HandlerCoordinatorContext } from '@wildflowerhealthio/effect-messaging-react'
import { NavigationBridgeHandler } from '@wildflowerhealthio/navigation-react'
import { usePromiseOrDefault } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBodyRendererContext } from '@wildflowerhealthio/react-tundraish'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import { Fragment, useMemo, type JSX, type PropsWithChildren, type ReactNode } from 'react'

import { renderScopeError } from '../scope-error-renderer.tsx'
import { PlatformBannerContext } from '../session/platform-banner-context.ts'
import { PlatformSettingsItemsProvider } from '../session/platform-settings-items.tsx'
import { stubTransport, TransportContext, type ReactTransport } from './transport-context.ts'

interface AppRootTreeProps {
  readonly router: AnyRouter
  readonly transportPromise: Promise<ReactTransport>
  /** The entry's platform-specific settings rows, provided to the tree so the
   * `/settings` route can append them. See {@link PlatformSettingsItemsProvider}. */
  readonly platformSettingsItems: readonly SettingsItem[]
  /** The entry's platform banner, provided to the tree so `<RootShell>` can
   * render it above every route. See {@link PlatformBannerContext}. */
  readonly platformBanner: ReactNode
}

/**
 * Owns the `transport` state seeded by `transportPromise`. Until the
 * promise resolves, `TransportContext` holds the `stubTransport`
 * (no-op sender) so the consumers below render without
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
  platformBanner,
}: AppRootTreeProps): JSX.Element => {
  const transport = usePromiseOrDefault(transportPromise, stubTransport, () => stubTransport)

  const InnerWrap = useMemo(
    () =>
      ({ children }: PropsWithChildren<object>): JSX.Element => (
        <Fragment>
          <NavigationBridgeHandler sender={transport.sendMessage} />
          {children}
        </Fragment>
      ),
    [transport.sendMessage]
  )

  return (
    <ErrorBodyRendererContext.Provider value={renderScopeError}>
      <PlatformSettingsItemsProvider items={platformSettingsItems}>
        <PlatformBannerContext value={platformBanner}>
          <TransportContext.Provider value={transport}>
            <HandlerCoordinatorContext.Provider value={transport.coordinator}>
              <RouterProvider router={router} InnerWrap={InnerWrap} />
            </HandlerCoordinatorContext.Provider>
          </TransportContext.Provider>
        </PlatformBannerContext>
      </PlatformSettingsItemsProvider>
    </ErrorBodyRendererContext.Provider>
  )
}

export { AppRootTree }
export type { AppRootTreeProps }
