import { useNavigate, useRouterState } from '@tanstack/react-router'
import { buildStepUpTarget } from 'gatekeeper-react'
import type { JSX } from 'react'
import { AuthorizationFailure } from 'scopes-react'

interface ScopeErrorSurfaceProps {
  /** The scopes the caller lacks, from the `403 InsufficientScope` body. */
  readonly missingScopes: readonly string[]
}

/**
 * The `403 InsufficientScope` surface plus its **step-up** action
 * (resource-authorization epic child ⑤). Renders the read-only
 * `AuthorizationFailure` and, when the 403 actually named scopes, wires its
 * `onRequestAccess` hook to a navigation to device login pre-filled with exactly
 * those scopes and with `returnTo` set to the current location — so a granted
 * request reloads this page and its loader re-runs the denied action against the
 * new grant.
 *
 * A component (not a bare `render` closure) because the step-up action needs the
 * router: it reads the current href and navigates. It only ever renders inside
 * `RouterProvider` — `ErrorBodyRendererContext` is provided above it in
 * `AppRootTree`, but every *consumer* (a route's error body, the databases
 * delete banner) is a descendant of the router.
 *
 * With no scopes named (the undeclared-403 path, where the body was never
 * decoded) the hook is omitted and the surface stays a read-only explanation:
 * there is nothing to pre-fill, so a "Request access" button would be
 * indistinguishable from a plain sign-in.
 *
 * Its own module so `scope-error-renderer.tsx` keeps exporting just the renderer
 * function (a file may not mix component and non-component exports).
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
