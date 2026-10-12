import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import { Option } from 'effect'
import { createContext, useContext } from 'react'

/**
 * The settings screen's Logout row, which `buildAppTree` builds over the
 * page's bearer store and the `/settings` route appends after every slice's
 * `*SettingsItemsFragment`.
 *
 * A React context (not TanStack router context) because this app's router
 * hooks are untyped — components read app-provided data through typed contexts
 * like this one, the same way `AuthStateProvider` threads the auth store.
 * Defaults to none, so a component mounted outside a provider (e.g. an
 * isolated unit test) simply renders no Logout row.
 */
const LogoutSettingsItemContext = createContext<Option.Option<SettingsItem>>(Option.none())

/** Read the settings screen's Logout row. */
const useLogoutSettingsItem = (): Option.Option<SettingsItem> =>
  useContext(LogoutSettingsItemContext)

export { LogoutSettingsItemContext, useLogoutSettingsItem }
