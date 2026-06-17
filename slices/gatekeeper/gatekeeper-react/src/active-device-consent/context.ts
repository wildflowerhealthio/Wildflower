import { createContext } from 'react'

import type { ActiveDeviceUserCodeStore } from './store.ts'

/**
 * Holds the {@link ActiveDeviceUserCodeStore} for descendants of
 * `ActiveDeviceUserCodeProvider`. Read with
 * `useActiveDeviceUserCode`. `null` outside a provider — the hook
 * throws.
 */
const ActiveDeviceUserCodeContext = createContext<ActiveDeviceUserCodeStore | null>(null)
ActiveDeviceUserCodeContext.displayName = 'ActiveDeviceUserCodeContext'

export { ActiveDeviceUserCodeContext }
