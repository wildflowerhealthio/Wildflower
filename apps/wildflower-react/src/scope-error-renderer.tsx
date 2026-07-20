import type { ReactNode } from 'react'
import { AuthorizationFailure } from 'scopes-react'

import { insufficientScopeFromFailure } from './router-context.ts'

/**
 * The app's error-body override for a `403 InsufficientScope`: a rejected
 * loader/query/mutation that carries one renders the in-place
 * {@link AuthorizationFailure} surface (naming the missing scopes); anything
 * else falls through (`null`) to the default error rendering. Supplied to
 * `ErrorBodyRendererContext` in {@link AppRootTree}, so every route's error body
 * — and the databases delete banner — picks it up. A 403 is an authorization
 * (not authentication) failure, so it surfaces in place rather than redirecting
 * to device login the way a 401 does.
 */
const renderScopeError = (error: unknown): ReactNode | null => {
  const scope = insufficientScopeFromFailure(error)
  return scope === null ? null : <AuthorizationFailure missingScopes={scope.missingScopes} />
}

export { renderScopeError }
