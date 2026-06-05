import type { JSX, ReactNode } from 'react'

import { ActiveDeviceRequestContext } from './active-device-request-context.ts'
import type { ActiveDeviceRequestStore } from './active-device-request-store.ts'

interface ActiveDeviceRequestProviderProps {
  /**
   * The {@link ActiveDeviceRequestStore} the device-consent modal host
   * reads from. The shared `app-root` constructs it and also hands its
   * `setActiveUserCode` to the gatekeeper bridge handler.
   */
  readonly store: ActiveDeviceRequestStore
  readonly children: ReactNode
}

/**
 * Provides the {@link ActiveDeviceRequestStore} to descendants.
 * The device-consent modal host reads the live head via
 * {@link useActiveDeviceRequest}.
 */
const ActiveDeviceRequestProvider = ({
  store,
  children,
}: ActiveDeviceRequestProviderProps): JSX.Element => (
  <ActiveDeviceRequestContext.Provider value={store}>
    {children}
  </ActiveDeviceRequestContext.Provider>
)

export { ActiveDeviceRequestProvider }
export type { ActiveDeviceRequestProviderProps }
