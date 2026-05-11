import { readToken, subscribeToken } from 'gatekeeper-react'
import { useSyncExternalStore } from 'react'

const noToken = (): null => null

/**
 * Subscribe to gatekeeper-react's bearer-token storage. Returns the
 * current token (or `null`) and re-renders the calling component on
 * token rotation — same-tab `writeToken` calls and cross-tab
 * `localStorage` events both flow through here.
 */
const useToken = (): string | null => useSyncExternalStore(subscribeToken, readToken, noToken)

export { useToken }
