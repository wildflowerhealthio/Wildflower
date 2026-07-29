import type { ReactNode } from 'react'

import { insufficientScopeFromFailure } from './router-context.ts'
import { ScopeErrorSurface } from './scope-error-surface.tsx'

/**
 * The app's error-body override for a `403 InsufficientScope`: a rejected
 * loader/query/mutation that carries one renders the in-place
 * {@link ScopeErrorSurface} (naming the missing scopes, and offering step-up when
 * the body named any); anything else falls through (`null`) to the default error
 * rendering. Supplied to `ErrorBodyRendererContext` in {@link AppRootTree}, so
 * every route's error body — and the databases delete banner — picks it up. A 403
 * is an authorization (not authentication) failure, so it surfaces in place
 * rather than redirecting to device login the way a 401 does; step-up is then the
 * user's choice, not an automatic redirect.
 */
const renderScopeError = (error: unknown): ReactNode | null => {
  const scope = insufficientScopeFromFailure(error)
  return scope === null ? null : <ScopeErrorSurface missingScopes={scope.missingScopes} />
}

export { renderScopeError }
