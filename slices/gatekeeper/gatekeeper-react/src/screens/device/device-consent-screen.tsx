import { unknownErrorToString } from 'kitchen-sink'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Field, FieldDescription, FieldGroup, pageLayoutStyles } from 'react-tundraish'

import {
  useDeviceConsentMutation,
  useDeviceConsentQuery,
  type DeviceConsent,
} from '../../queries/index.ts'
import pageLayout from '../../styles/page-layout.module.css'
import scopeListStyles from '../../styles/scope-list.module.css'

type DeviceConsentFormProps = {
  readonly consent: DeviceConsent
  readonly onDone: () => void
}

/**
 * The device-authorization consent form, lifted out of its route so the
 * public (`/gatekeeper/devices/$userCode`) and owner-facing
 * (`/settings/gatekeeper/devices/$userCode`) surfaces share one
 * implementation and differ only in their page header (the in-settings one
 * carries a back link). Renders no header itself — each route supplies its
 * own `<PageHeader>`.
 */
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

type DeviceConsentScreenProps = {
  readonly userCode: string
  readonly onDone: () => void
}

/**
 * Reads the pending device consent for `userCode` (warmed by the route
 * loader, so this resolves from cache) and renders the shared
 * {@link DeviceConsentForm}. Shared by the public and in-settings consent
 * routes; each passes its own `onDone`.
 */
const DeviceConsentScreen = ({ userCode, onDone }: DeviceConsentScreenProps): JSX.Element => {
  const { data: consent } = useDeviceConsentQuery(userCode)
  return <DeviceConsentForm consent={consent} onDone={onDone} />
}

export { DeviceConsentForm, DeviceConsentScreen }
export type { DeviceConsentFormProps, DeviceConsentScreenProps }
