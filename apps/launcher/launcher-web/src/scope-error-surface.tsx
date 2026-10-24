import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuthStateSetter } from '@wildflowerhealthio/react-kitchen-sink'
import { AuthorizationFailure } from '@wildflowerhealthio/scopes-react'
import type { JSX } from 'react'

import { signInAgain } from './session/sign-in-again.ts'

/**
 * The lead line for a denial whose missing scopes say which of the launcher's
 * own actions was refused, keyed by the one scope missing. A browser the Owner
 * paired with less than the launcher asks for signs in without
 * `wildflower/Apps.r`, so Home (and the apps settings list) can't list apps:
 * the surface says that rather than a generic refusal.
 */
const DENIED_ACTIONS: Readonly<Record<string, string>> = {
  'wildflower/Apps.r': 'This browser isn’t allowed to list apps',
}

/** The lead line naming what was refused, when `missingScopes` is one scope with its own. */
const deniedAction = (missingScopes: readonly string[]): string | undefined => {
  const [only, ...rest] = new Set(missingScopes)
  return only !== undefined && rest.length === 0 ? DENIED_ACTIONS[only] : undefined
}

interface ScopeErrorSurfaceProps {
  /** The scopes the caller lacks, from the `403 InsufficientScope` body. */
  readonly missingScopes: readonly string[]
}

/**
 * The `403 InsufficientScope` surface plus its **step-up** action: the read-only
 * `AuthorizationFailure`, whose `onRequestAccess` hook signs in again to the
 * session's server with `returnTo` set here and `prompt=consent`
 * (`session/sign-in-again.ts`). The server decides which case it is: when this
 * browser's own session lacks the missing scopes, the sign-in stops at its
 * limited page, even after a Continue there before, where the browser can ask
 * the Owner to widen its session; when the session holds them and only the
 * launcher's grant lacks them, the new authorization request goes to the
 * Owner's consent rather than through on the old grant. See the
 * [Scope-Gated Endpoints How-To](../../../../docs/Authorization/Scope-Gated%20Endpoints%20How-To.md)
 * for the flow end to end.
 *
 * A denial for a single scope the launcher names an action for leads with
 * that action ({@link DENIED_ACTIONS}), e.g. "This browser isn’t allowed to
 * list apps"; any other leads with the generic heading.
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
          signInAgain(setAuthState, (target) => navigate(target), href, 'consent')
        }
  return (
    <AuthorizationFailure
      action={deniedAction(missingScopes)}
      missingScopes={missingScopes}
      onRequestAccess={onRequestAccess}
    />
  )
}

export { ScopeErrorSurface }
export type { ScopeErrorSurfaceProps }
