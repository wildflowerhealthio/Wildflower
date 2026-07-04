import { useContextOrThrow } from '../hooks/use-context-or-throw.ts'
import { AuthTokenContext } from './auth-token-context.ts'
import type { AuthTokenStore } from './auth-token-store.ts'

/**
 * Returns the `setSignal` function from the nearest
 * `<AuthTokenProvider>`'s store. Throws when no provider is in the
 * tree.
 *
 * Use this from components that publish a new auth signal — the
 * gatekeeper device-login completion, a sign-out flow, etc. The
 * returned setter is stable for the surrounding store's lifetime, so
 * it's safe to put in a `useEffect`'s dep array.
 */
const useAuthTokenSetter = (): AuthTokenStore['setSignal'] =>
  useContextOrThrow(AuthTokenContext).setSignal

export { useAuthTokenSetter }
