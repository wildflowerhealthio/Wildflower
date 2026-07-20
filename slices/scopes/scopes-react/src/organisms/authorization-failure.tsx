import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { Scope } from 'scopes-core'

import React from 'react'
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
 * A plain-language phrase for a missing scope — the verb(s) it grants and the
 * record type they act on, e.g. `wildflower/Accounts.r` → "read Accounts",
 * `wildflower/Grant.cd` → "create and delete Grants". Reuses the domain's own
 * fluency (the scope form's plain statements read the same `permission.label()`
 * words and `resource.pluralLabel()` names), so this surface never shows a raw
 * `context/Resource.perms` string as its primary text.
 *
 * `null` when the string has no (verb, resource) shape — a bare known flag
 * (`openid`), the `wildflower/launch` umbrella, or an unparseable token — where
 * the raw scope is shown as the fallback instead.
 */
const fluentScope = (raw: string): string | null => {
  const parsed = Scope.parse(raw)
  if (!Scope.ResourceScope.isResourceScope(parsed)) return null
  // `permission.label()` is the same sentence-joined verb list the scope form's
  // statements render ("Read", "Create and Delete"); lower-cased to sit mid-line
  // after "permission to". `pluralLabel()` matches the form's running-sentence
  // resource wording ("Accounts", "Grants").
  return `${parsed.permission.label().toLowerCase()} ${parsed.resource.pluralLabel()}`
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
      <h2 className={cn(styles['title'], 'text-heading-2')}>
        {action ?? 'You don’t have permission to do that'}
      </h2>
      {scopes.length === 0 ? (
        <p className={cn(styles['body'], 'text-body-3')}>
          Your session doesn’t carry the permission this action requires.
        </p>
      ) : (
        <>
          <p className={cn(styles['body'], 'text-body-3')}>
            Your session doesn’t have permission to:
            {scopes.map((scope, i) => {
              const phrase = fluentScope(scope)
              // A resource scope reads as plain language ("read Accounts"); the
              // canonical scope stays available on hover for anyone who needs it.
              // A non-resource scope (a bare flag / umbrella / unparseable token)
              // has no fluent form, so the raw string is the fallback.
              const scopeElement =
                phrase !== null ? (
                  <span className={styles['scope']} title={scope}>
                    {phrase}
                  </span>
                ) : (
                  <code className={styles['code']}>{scope}</code>
                )

              return (
                <React.Fragment key={scope}>
                  {scopeElement}
                  {i !== scopes.length - 1 ? ',' : ''}
                </React.Fragment>
              )
            })}
          </p>
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
