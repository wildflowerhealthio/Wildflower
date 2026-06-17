import type { JSX, ReactNode } from 'react'

import { ActiveDeviceUserCodeContext } from './context.ts'
import type { ActiveDeviceUserCodeStore } from './store.ts'

interface ActiveDeviceUserCodeProviderProps {
  readonly store: ActiveDeviceUserCodeStore
  readonly children: ReactNode
}

/**
 * Provide the {@link ActiveDeviceUserCodeStore} to descendants. The
 * app's `renderApp` wraps the router tree in this so the
 * {@link DeviceConsentModalHost} (mounted alongside `<Outlet />`) and
 * the bridge handler share one store.
 */
const ActiveDeviceUserCodeProvider = ({
  store,
  children,
}: ActiveDeviceUserCodeProviderProps): JSX.Element => (
  <ActiveDeviceUserCodeContext.Provider value={store}>
    {children}
  </ActiveDeviceUserCodeContext.Provider>
)

export { ActiveDeviceUserCodeProvider }
export type { ActiveDeviceUserCodeProviderProps }
