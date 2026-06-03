import { createContext } from 'react'

import type { AuthTokenStore } from './auth-token-store.ts'

/**
 * React context carrying the {@link AuthTokenStore} for the bearer
 * token. Apps wire it via `<AuthTokenProvider>` with an
 * environment-specific store (per-entry factories live in
 * `gatekeeper-react/token-storage` — `makeWebAuthTokenStore` for
 * standalone web, `makeEmbeddedAuthTokenStore` for the in-WebView SPA).
 *
 * Both halves of the store ride one context so React-side consumers
 * never have to pair up two providers (one for read, one for write) —
 * a missing provider on either side would silently land in the wrong
 * code path; co-locating them makes the `useAuthTokenSetter()` /
 * `useAuthTokenSubscribable()` hooks impossible to half-wire.
 */
const AuthTokenContext = createContext<AuthTokenStore | null>(null)

export { AuthTokenContext }
