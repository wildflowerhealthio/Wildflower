import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge } from 'react-tundraish'
import { Scope } from 'scopes-core'

import styles from './authorization-failure.module.css'

interface AuthorizationFailureProps {
  /**
   * The scopes the caller lacks, as canonical scope strings (e.g.
   * `wildflower/Grant.d`) — the `missingScopes` of a `403 InsufficientScope`.
   * Empty when the failure was detected but its body wasn't decoded (an
   * endpoint that hasn't declared the 403 yet): the surface then explains the
   * denial without naming a specific scope.
   */
  readonly missingScopes: readonly string[]
  /**
   * Step-up hook (resource-authorization epic child ⑤): when supplied, a
   * "Request access" affordance is rendered that invokes it. The request action
   * itself is deliberately out of scope for this component — it only exposes the
   * hook, so the surface stays render-only until the step-up flow wires it.
   */
  readonly onRequestAccess?: () => void
  /**
   * Optional lead line naming the action that was denied, e.g. "Delete this
   * database". Falls back to a generic heading.
   */
  readonly action?: ReactNode
  readonly className?: string
}

/**
 * A friendly resource label for a scope string (e.g. `wildflower/Grant.d` →
 * "Grant"), or `null` when the string isn't a resource scope (a bare known
 * scope like `openid`, or an unparseable one) — the raw scope is always shown
 * regardless, so an unlabelled scope still reads unambiguously.
 */
const resourceLabelFor = (raw: string): string | null => {
  const parsed = Scope.parse(raw)
  return Scope.ResourceScope.isResourceScope(parsed) ? parsed.resource.singularLabel() : null
}

/**
 * The read-only **authorization-failure** surface: the caller is authenticated
 * but their token doesn't cover the scope(s) an action requires (a `403
 * InsufficientScope`). It names the missing scopes — the canonical scope string
 * plus a friendly resource label where one exists — so the user knows *which*
 * permission is missing rather than seeing an opaque error, and exposes an
 * optional step-up hook. Presentational only: detection + the request action
 * live with the caller (the web query runtime and epic child ⑤).
 */
const AuthorizationFailure = ({
  missingScopes,
  onRequestAccess,
  action,
  className,
}: AuthorizationFailureProps): JSX.Element => {
  // De-duplicate so each scope is one row (and a stable, data-dependent key).
  const scopes = [...new Set(missingScopes)]
  return (
    <section className={cn(styles['surface'], className)} role="alert">
      <StatusBadge tone="danger">Not permitted</StatusBadge>
      <h2 className={cn(styles['title'], 'text-heading-3')}>
        {action ?? 'You don’t have permission to do that'}
      </h2>
      {scopes.length === 0 ? (
        <p className={cn(styles['body'], 'text-body-3')}>
          Your session doesn’t carry the permission this action requires.
        </p>
      ) : (
        <>
          <p className={cn(styles['body'], 'text-body-3')}>
            It needs {scopes.length === 1 ? 'a permission' : 'permissions'} your session doesn’t
            have:
          </p>
          <ul className={styles['scopes']}>
            {scopes.map((scope) => {
              const label = resourceLabelFor(scope)
              return (
                <li key={scope} className={styles['scope']}>
                  {label !== null ? <span className={styles['label']}>{label}</span> : null}
                  <code className={styles['code']}>{scope}</code>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {onRequestAccess !== undefined ? (
        <button type="button" className="button-3" onClick={onRequestAccess}>
          Request access
        </button>
      ) : null}
    </section>
  )
}

export { AuthorizationFailure, type AuthorizationFailureProps }
