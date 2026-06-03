import { AuthTokenContext } from './auth-token-context.ts'
import type { AuthTokenStore } from './auth-token-store.ts'
import { useContextOrThrow } from '../hooks/use-context-or-throw.ts'

/**
 * Returns the `setToken` function from the nearest
 * `<AuthTokenProvider>`'s store. Throws when no provider is in the
 * tree.
 *
 * Use this from components that rotate the bearer token — the
 * gatekeeper device-login completion, a sign-out button, etc. The
 * returned setter is stable for the surrounding store's lifetime, so
 * it's safe to put in a `useEffect`'s dep array.
 */
const useAuthTokenSetter = (): AuthTokenStore['setToken'] =>
  useContextOrThrow(AuthTokenContext).setToken

export { useAuthTokenSetter }
