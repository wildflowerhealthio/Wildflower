import { useNavigate, useRouterState } from '@tanstack/react-router'
import { buildStepUpTarget } from 'gatekeeper-react'
import type { JSX } from 'react'
import { AuthorizationFailure } from 'scopes-react'

interface ScopeErrorSurfaceProps {
  /** The scopes the caller lacks, from the `403 InsufficientScope` body. */
  readonly missingScopes: readonly string[]
}

/**
 * The `403 InsufficientScope` surface plus its **step-up** action: the read-only
 * `AuthorizationFailure`, whose `onRequestAccess` hook navigates to device login
 * pre-filled with the missing scopes and with `returnTo` set here. See the
 * [Scope-Gated Endpoints How-To](../../../docs/Authorization/Scope-Gated%20Endpoints%20How-To.md)
 * for the flow end to end.
 *
 * With no scopes named (the undeclared-403 path, where the body was never
 * decoded) the hook is omitted: there is nothing to pre-fill, so a "Request
 * access" button would be indistinguishable from a plain sign-in.
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
  const href = useRouterState({ select: (state) => state.location.href })
  const onRequestAccess =
    missingScopes.length === 0
      ? undefined
      : (): void => {
          void navigate(buildStepUpTarget(missingScopes, href))
        }
  return <AuthorizationFailure missingScopes={missingScopes} onRequestAccess={onRequestAccess} />
}

export { ScopeErrorSurface }
export type { ScopeErrorSurfaceProps }
