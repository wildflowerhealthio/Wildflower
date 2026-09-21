import type { PendingConsentHead } from 'gatekeeper-core/bridge'
import { useContextOrThrow, useSubscribable } from 'react-kitchen-sink'

import { ActivePendingConsentContext } from './context.ts'

/**
 * Subscribe to the head of the pending-consent queue.
 * Re-renders on every change. Throws when used outside an
 * `<ActivePendingConsentProvider>` — accidental consumers without a
 * wired store have no useful fallback.
 *
 * The actual `Subscribable → React` bridge lives in
 * {@link useSubscribable}; this hook is the typed lookup against the
 * provider context plus a missing-provider throw.
 */
const useActivePendingConsent = (): PendingConsentHead | null => {
  const store = useContextOrThrow(ActivePendingConsentContext)
  return useSubscribable(store.subscribable)
}

export { useActivePendingConsent }
