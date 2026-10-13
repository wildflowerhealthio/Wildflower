import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import { ErrorBodyRendererContext } from '@wildflowerhealthio/react-tundraish'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import { Option } from 'effect'
import type { JSX } from 'react'

import { renderScopeError } from '../scope-error-renderer.tsx'
import { LogoutSettingsItemContext } from '../session/logout-settings-item-context.ts'

interface AppRootTreeProps {
  readonly router: AnyRouter
  /** The settings screen's Logout row, provided to the tree so the `/settings`
   * route can append it. See {@link LogoutSettingsItemContext}. */
  readonly logoutSettingsItem: SettingsItem
}

/**
 * The providers the router renders under: the scope-error renderer every
 * route's error body uses, and the settings screen's Logout row.
 */
const AppRootTree = ({ router, logoutSettingsItem }: AppRootTreeProps): JSX.Element => (
  <ErrorBodyRendererContext.Provider value={renderScopeError}>
    <LogoutSettingsItemContext value={Option.some(logoutSettingsItem)}>
      <RouterProvider router={router} />
    </LogoutSettingsItemContext>
  </ErrorBodyRendererContext.Provider>
)

export { AppRootTree }
export type { AppRootTreeProps }
