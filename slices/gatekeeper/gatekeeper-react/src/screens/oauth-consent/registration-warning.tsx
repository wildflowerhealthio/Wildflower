import type { JSX } from 'react'
import { Scope } from 'scopes-core'

import type { OAuthConsentResource } from '../../queries/index.ts'
import styles from './registration-warning.module.css'

type Registration = OAuthConsentResource['registration']

interface RegistrationWarningProps {
  /** The consent's trust-on-first-use standing — see `OAuthConsentRegistrationSchema`. */
  readonly registration: Registration
  readonly clientId: string
  readonly redirectUri: string
  /** Whether the "I recognise this app" checkbox is currently ticked. */
  readonly acknowledged: boolean
  readonly onAcknowledgeChange: (acknowledged: boolean) => void
}

/** `redirectUri`'s origin, or the raw string if it doesn't parse as a URL. */
const originOf = (redirectUri: string): string => {
  try {
    return new URL(redirectUri).origin
  } catch {
    return redirectUri
  }
}

/**
 * A scope's plain-language label when it's a known (flag) scope — the same copy
 * `ScopePicker` shows — falling back to the raw wire string for resource and
 * unknown scopes, which have no single-line label outside the picker's grid.
 */
const scopeLabel = (raw: string): string => {
  const parsed = Scope.parse(raw)
  return parsed.kind === 'known' ? parsed.plainExplanation() : raw
}

const RedirectDetail = ({ redirectUri }: { readonly redirectUri: string }): JSX.Element => (
  <>
    <code className={styles['origin']}>{originOf(redirectUri)}</code>
    <code className={styles['fullUri']}>{redirectUri}</code>
  </>
)

/**
 * The trust-on-first-use warning callout shown above the `ScopePicker` when a
 * consent's `registration` status is `new` or `changed` (never `registered`,
 * which renders nothing). Requires the Owner to tick an acknowledgment checkbox
 * before {@link OAuthConsentForm} allows approval — the callout owns the
 * checkbox's rendering and copy, the form owns gating the Approve button on it.
 */
const RegistrationWarning = ({
  registration,
  clientId,
  redirectUri,
  acknowledged,
  onAcknowledgeChange,
}: RegistrationWarningProps): JSX.Element | null => {
  if (registration.status === 'registered') return null

  return (
    <div className={styles['callout']} role="note">
      <p className={styles['heading']}>
        <span aria-hidden="true" className={styles['icon']}>
          ⚠
        </span>
        {registration.status === 'new'
          ? 'This app has never been seen before'
          : "This app's request differs from its registration"}
      </p>

      {registration.status === 'new' ? (
        <p className={styles['body']}>
          <code>{clientId}</code> is not a registered app. Approving will register it, along with
          the redirect address <RedirectDetail redirectUri={redirectUri} />, using the scopes you
          grant below.
        </p>
      ) : (
        <>
          {registration.redirectUriIsNew ? (
            <p className={styles['body']}>
              This app is asking to redirect to a new address it hasn't used before:{' '}
              <RedirectDetail redirectUri={redirectUri} />
            </p>
          ) : null}
          {registration.newScopes.length > 0 ? (
            <div className={styles['body']}>
              <p className={styles['body']}>
                This app was not previously allowed to request the following:
              </p>
              <ul className={styles['scopeList']}>
                {registration.newScopes.map((scope) => (
                  <li key={scope}>{scopeLabel(scope)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}

      <label className={styles['acknowledge']}>
        <input
          type="checkbox"
          className={styles['checkbox']}
          checked={acknowledged}
          onChange={(event) => {
            onAcknowledgeChange(event.target.checked)
          }}
        />
        I recognise this app and this redirect address
      </label>
    </div>
  )
}

export { RegistrationWarning }
export type { RegistrationWarningProps }
