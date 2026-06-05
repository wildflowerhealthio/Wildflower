import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'

import { useDeviceConsentMutation, type DeviceConsent } from '../../queries/index.ts'
import pageLayout from '../../styles/page-layout.module.css'
import scopeListStyles from '../../styles/scope-list.module.css'

interface DeviceConsentFormProps {
  readonly consent: DeviceConsent
  readonly onDone: () => void
  /**
   * Whether to render the form's own `<h1>` heading. `true` for the
   * standalone `/gatekeeper/devices/$userCode` route; `false` inside the
   * device-consent modal, where the surrounding `<Dialog>` already
   * supplies the "Device Authorization" title.
   */
  readonly showHeading?: boolean
}

/**
 * The device-authorization consent form: scope checkboxes plus
 * Approve/Decline. Shared by the standalone `_auth` route and the in-app
 * {@link DeviceAuthorizationModalHost} popup. `onDone` fires once a
 * decision (approve or deny) resolves so the caller can dismiss.
 */
const DeviceConsentForm = ({
  consent,
  onDone,
  showHeading = true,
}: DeviceConsentFormProps): JSX.Element => {
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
      {showHeading ? <h1 className="text-heading-6">Device Authorization</h1> : null}

      <Field label="Code">
        <span className="text-body-2">
          <code>{consent.userCode}</code>
        </span>
      </Field>

      <Field label="Application">
        <span className="text-body-2">{consent.clientName}</span>
        <FieldDescription>
          <code>{consent.clientId}</code>
        </FieldDescription>
      </Field>

      <Field label="Requested Scopes">
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
      </Field>

      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className={pageLayout['buttons']}>
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
        <button
          type="button"
          className="button-2 filled accent-red"
          disabled={submitting}
          onClick={handleDecline}
        >
          Decline
        </button>
      </div>
    </>
  )
}

export { DeviceConsentForm }
export type { DeviceConsentFormProps }
