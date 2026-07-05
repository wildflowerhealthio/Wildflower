import { useContextOrThrow } from '../hooks/use-context-or-throw.ts'
import { AuthStateContext } from './auth-state-context.ts'
import type { AuthStateStore } from './auth-state-store.ts'

/**
 * Returns the `setAuthState` function from the nearest
 * `<AuthStateProvider>`'s store. Throws when no provider is in the
 * tree.
 *
 * Use this from components that publish a new auth signal — the
 * gatekeeper device-login completion, a sign-out flow, etc. The
 * returned setter is stable for the surrounding store's lifetime, so
 * it's safe to put in a `useEffect`'s dep array.
 */
const useAuthStateSetter = (): AuthStateStore['setAuthState'] =>
  useContextOrThrow(AuthStateContext).setAuthState

export { useAuthStateSetter }
