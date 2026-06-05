import { createContext } from 'react'

import type { ActiveDeviceRequestStore } from './active-device-request-store.ts'

/**
 * React context carrying the {@link ActiveDeviceRequestStore} for the
 * in-app device-consent popup. Apps wire it via
 * `<ActiveDeviceRequestProvider>` with a store constructed in the shared
 * `app-root`. The modal host reads it through
 * {@link useActiveDeviceRequest}; the write side is handed straight to
 * the gatekeeper bridge handler at entrypoint wiring time, so it does
 * not flow back through this context.
 */
const ActiveDeviceRequestContext = createContext<ActiveDeviceRequestStore | null>(null)
ActiveDeviceRequestContext.displayName = 'ActiveDeviceRequestContext'

export { ActiveDeviceRequestContext }
