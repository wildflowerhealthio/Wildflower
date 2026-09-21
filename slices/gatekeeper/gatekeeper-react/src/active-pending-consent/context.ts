import { createContext } from 'react'

import type { ActivePendingConsentStore } from './store.ts'

/**
 * Holds the {@link ActivePendingConsentStore} for descendants of
 * `ActivePendingConsentProvider`. Read with
 * `useActivePendingConsent`. `null` outside a provider — the hook
 * throws.
 */
const ActivePendingConsentContext = createContext<ActivePendingConsentStore | null>(null)
ActivePendingConsentContext.displayName = 'ActivePendingConsentContext'

export { ActivePendingConsentContext }
