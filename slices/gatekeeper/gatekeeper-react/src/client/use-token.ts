import { useSyncExternalStore } from 'react'

import { readToken, subscribeToken } from './token-storage.ts'

const noToken = (): null => null

/**
 * Subscribe to the gatekeeper bearer-token storage. Returns the
 * current token (or `null`) and re-renders the calling component on
 * token rotation — same-tab `writeToken` calls and cross-tab
 * `localStorage` events both flow through here.
 *
 * Apps that need to react to auth state (e.g. an `<AuthorizedAppShell>`
 * deciding whether to render `<NeedsAuthMessage>` or the protected
 * subtree) call this hook; the change is observable without any
 * additional plumbing.
 */
const useToken = (): string | null => useSyncExternalStore(subscribeToken, readToken, noToken)

export { useToken }
