import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import { ErrorBodyRendererContext } from '@wildflowerhealthio/react-tundraish'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import { Option } from 'effect'
import type { JSX } from 'react'

import { renderScopeError } from './scope-error-renderer.tsx'
import { LogoutSettingsItemContext } from './session/logout-settings-item-context.ts'
import {
  ManageAccessSourceContext,
  type ManageAccessSource,
} from './session/manage-access-settings-item.ts'

interface AppRootTreeProps {
  readonly router: AnyRouter
  /** The settings screen's Logout row, provided to the tree so the `/settings`
   * route can append it. See {@link LogoutSettingsItemContext}. */
  readonly logoutSettingsItem: SettingsItem
  /** Where the settings screen's Manage access row reads the session's
   * server's `management_endpoint` from. See {@link ManageAccessSourceContext}. */
  readonly manageAccessSource: ManageAccessSource
}

/**
 * The providers the router renders under: the scope-error renderer every
 * route's error body uses, the settings screen's Logout row, and where its
 * Manage access row finds the session's server.
 */
const AppRootTree = ({
  router,
  logoutSettingsItem,
  manageAccessSource,
}: AppRootTreeProps): JSX.Element => (
  <ErrorBodyRendererContext.Provider value={renderScopeError}>
    <LogoutSettingsItemContext value={Option.some(logoutSettingsItem)}>
      <ManageAccessSourceContext value={manageAccessSource}>
        <RouterProvider router={router} />
      </ManageAccessSourceContext>
    </LogoutSettingsItemContext>
  </ErrorBodyRendererContext.Provider>
)

export { AppRootTree }
export type { AppRootTreeProps }
