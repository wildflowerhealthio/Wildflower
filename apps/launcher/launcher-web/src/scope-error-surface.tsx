import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuthStateSetter } from '@wildflowerhealthio/react-kitchen-sink'
import { AuthorizationFailure } from '@wildflowerhealthio/scopes-react'
import type { JSX } from 'react'

import { signInAgain } from './session/sign-in-again.ts'

interface ScopeErrorSurfaceProps {
  /** The scopes the caller lacks, from the `403 InsufficientScope` body. */
  readonly missingScopes: readonly string[]
}

/**
 * The `403 InsufficientScope` surface plus its **step-up** action: the read-only
 * `AuthorizationFailure`, whose `onRequestAccess` hook signs in again to the
 * session's server with `returnTo` set here (`session/sign-in-again.ts`). The
 * session's grant does not cover the missing scopes, so the new authorization
 * request goes to the Owner's consent rather than through on the old grant. See the
 * [Scope-Gated Endpoints How-To](../../../../docs/Authorization/Scope-Gated%20Endpoints%20How-To.md)
 * for the flow end to end.
 *
 * With no scopes named (the undeclared-403 path, where the body was never
 * decoded) the hook is omitted: nothing says which permission the denial was
 * about, so there is nothing to ask the Owner for.
 *
 * A component rather than a bare `render` closure because the action needs the
 * router. It only ever renders inside `RouterProvider` — `ErrorBodyRendererContext`
 * is provided above it in `AppRootTree`, but every *consumer* (a route's error
 * body, the databases delete banner) is a descendant of the router. Its own
 * module so `scope-error-renderer.tsx` keeps exporting just the renderer function
 * (a file may not mix component and non-component exports).
 */
const ScopeErrorSurface = ({ missingScopes }: ScopeErrorSurfaceProps): JSX.Element => {
  const navigate = useNavigate()
  const setAuthState = useAuthStateSetter()
  const href = useRouterState({ select: (state) => state.location.href })
  const onRequestAccess =
    missingScopes.length === 0
      ? undefined
      : (): void => {
          signInAgain(setAuthState, (target) => navigate(target), href)
        }
  return <AuthorizationFailure missingScopes={missingScopes} onRequestAccess={onRequestAccess} />
}

export { ScopeErrorSurface }
export type { ScopeErrorSurfaceProps }
