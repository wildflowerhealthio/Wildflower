/**
 * Shared device-consent form, reused by:
 *
 *  - the standalone `/gatekeeper/devices/:userCode` route, which
 *    navigates away on `onDone`, and
 *  - the in-app {@link DeviceConsentModalHost} popup (Tauri only),
 *    which closes the modal on `onDone`.
 *
 * The two callers differ only in the `onDone` policy and whether they
 * need the surrounding `<h1>` heading — the modal supplies the title
 * via its Dialog header. Everything else (scope toggle, approve/decline
 * mutation, stale-denied clearing, mutation-error precedence) is shared.
 *
 * Renders the design-system "device authorization" card; its skin lives in
 * `device-consent-form.module.css` (token-driven). The surrounding chrome
 * (page shell + `PageHeader`, or the `Dialog`) is the caller's.
 */

import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Field, FieldDescription, FieldGroup, pageLayoutStyles } from 'react-tundraish'

import { useDeviceConsentMutation, type DeviceConsent } from '../../queries/index.ts'
import scopeListStyles from '../../styles/scope-list.module.css'
import styles from './device-consent-form.module.css'

interface DeviceConsentFormProps {
  readonly consent: DeviceConsent
  readonly onDone: () => void
}

const DeviceConsentForm = ({ consent, onDone }: DeviceConsentFormProps): JSX.Element => {
  const requestedScopes = consent.requestedScopes
  const consentMutation = useDeviceConsentMutation()
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<string>>(
    () => new Set(requestedScopes)
  )
  const [denied, setDenied] = useState(false)

  const submitting = consentMutation.isPending
  const mutationError =
    consentMutation.error === null ? null : unknownErrorToString(consentMutation.error)
  // A genuine mutation failure takes precedence over a stale "denied"
  // flag: if a later approve/deny attempt throws (e.g. a network error)
  // while `denied` lingers from an earlier server-side denial, the user
  // must see the real error, not the old denial copy.
  const errorMessage = mutationError ?? (denied ? 'Authorization request was denied.' : null)

  const toggleScope = (scope: string): void => {
    // Clear a stale denial when the user re-toggles scopes for a fresh
    // attempt, so the denial message doesn't linger across a new approve.
    setDenied(false)
    setSelectedScopes((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) {
        next.delete(scope)
      } else {
        next.add(scope)
      }
      return next
    })
  }

  const handleApprove = (): void => {
    setDenied(false)
    consentMutation.mutate(
      { kind: 'approve', userCode: consent.userCode, approvedScopes: [...selectedScopes] },
      {
        onSuccess: (result) => {
          if (result.status === 'approved') {
            onDone()
          } else {
            setDenied(true)
          }
        },
      }
    )
  }

  const handleDecline = (): void => {
    setDenied(false)
    consentMutation.mutate(
      { kind: 'deny', userCode: consent.userCode },
      {
        onSuccess: (result) => {
          if (result.status === 'denied' || result.status === 'approved') {
            onDone()
          }
        },
      }
    )
  }

  return (
    <>
      <p className={styles['intro']}>A new device is requesting access to your account.</p>

      <Field label="Pairing code">
        <div className={styles['code-box']}>{consent.userCode}</div>
      </Field>

      <Field label="Application">
        <span className={styles['app-name']}>{consent.clientName}</span>
        <FieldDescription>
          <code>{consent.clientId}</code>
        </FieldDescription>
      </Field>

      <FieldGroup label="Requested Scopes">
        <FieldDescription>Select which permissions to grant this device.</FieldDescription>
        <div className={scopeListStyles['scope-list']}>
          {requestedScopes.map((scope) => (
            <Checkbox
              key={scope}
              checked={selectedScopes.has(scope)}
              onChange={() => {
                toggleScope(scope)
              }}
              label={<code>{scope}</code>}
            />
          ))}
        </div>
      </FieldGroup>

      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className={styles['actions']}>
        <button
          type="button"
          className="button-2 outline accent-red"
          disabled={submitting}
          onClick={handleDecline}
        >
          Decline
        </button>
        <button
          type="button"
          className="button-2 filled"
          disabled={selectedScopes.size === 0 || submitting}
          onClick={handleApprove}
        >
          {selectedScopes.size < requestedScopes.length
            ? `Approve (${selectedScopes.size}/${requestedScopes.length})`
            : 'Approve'}
        </button>
      </div>

      <p className={styles['footnote']}>Only approve devices you recognize.</p>
    </>
  )
}

export { DeviceConsentForm }
export type { DeviceConsentFormProps }
