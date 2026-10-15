/**
 * The device-consent card: the RFC 8628 request a device made, for the Owner to
 * approve or decline.
 *
 * The device-code consent is **expandable**: the owner edits the request through
 * the shared {@link ScopePicker} in `expandable` mode, so they can add scopes the
 * device didn't request (up to the client's `allowedScopes`) as well as prune
 * them. The submitted grant is whatever the draft serializes to.
 *
 * Renders the design-system "device authorization" card; its skin lives in
 * `device-consent-card.module.css` (token-driven). The surrounding chrome
 * (the page shell and its `PageHeader`) is the caller's.
 */

import type { UseMutationResult } from '@tanstack/react-query'
import { ErrorBanner, Field, FieldDescription } from '@wildflowerhealthio/react-tundraish'
import { GrantDraft, ScopeRequest } from '@wildflowerhealthio/scopes-core'
import { ScopePicker } from '@wildflowerhealthio/scopes-react'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'

import type {
  DeviceConsent,
  DeviceConsentDecision,
  DeviceConsentResult,
} from '../../queries/index.ts'
import styles from './device-consent-card.module.css'

/**
 * What the card sends the Owner's decision through: a device-consent mutation's
 * `mutate`, and its pending state and failure. The card only reads these, so
 * the surface composing it decides whose session the decision runs on.
 */
type DeviceConsentMutation = Pick<
  UseMutationResult<DeviceConsentResult, Error, DeviceConsentDecision>,
  'mutate' | 'isPending' | 'error'
>

interface DeviceConsentCardProps {
  readonly consent: DeviceConsent
  readonly consentMutation: DeviceConsentMutation
  /** Called with the server's answer once the Owner's decision is recorded. */
  readonly onDone: (result: DeviceConsentResult) => void
}

/**
 * The device-consent card. What sends the decision comes from its composer:
 * `DeviceConsentForm` on the router's authed runner, or the authorization
 * server's own device page on the Owner browser's session.
 */
const DeviceConsentCard = ({
  consent,
  consentMutation,
  onDone,
}: DeviceConsentCardProps): JSX.Element => {
  // Expandable envelope: seed the sections from what the device requested, but let the owner
  // grant anything within the client's allowed set.
  const request = useMemo(
    () =>
      ScopeRequest.expandable({
        requested: consent.requestedScopes,
        available: consent.allowedScopes,
      }),
    [consent]
  )
  const [draft, setDraft] = useState(() => GrantDraft.fromScopes(consent.requestedScopes, null))
  const [denied, setDenied] = useState(false)

  const submitting = consentMutation.isPending
  // A genuine mutation failure (a `403` shows the permission surface) takes
  // precedence over a stale "denied" flag; `ErrorBanner` renders whichever is set.
  const error = consentMutation.error ?? (denied ? 'Authorization request was denied.' : null)

  // The statement subject: the name the device supplied at pairing, or the
  // registered client name when it supplied none.
  const subjectName = (consent.deviceName ?? '') || consent.clientName

  // The device's name, read only, when the device named itself.
  const renderDeviceName = (): JSX.Element | null => {
    if (consent.deviceName !== null && consent.deviceName !== undefined) {
      return (
        <Field label="Device name">
          <span className={styles['app-name']}>{consent.deviceName}</span>
        </Field>
      )
    }
    return null
  }

  const handleApprove = (): void => {
    setDenied(false)
    consentMutation.mutate(
      {
        kind: 'approve',
        userCode: consent.userCode,
        approvedScopes: GrantDraft.serializeAll(draft),
        // The chosen launch patient rides to the token's `patient` claim; the picker
        // clears it when the subject switches to all-patients.
        ...(draft.patient === null ? {} : { patient: draft.patient }),
      },
      {
        onSuccess: (result) => {
          if (result.status === 'approved') {
            onDone(result)
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
          onDone(result)
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

      {renderDeviceName()}

      <Field label="Application">
        <span className={styles['app-name']}>{consent.clientName}</span>
        <FieldDescription>
          <code>{consent.clientId}</code>
        </FieldDescription>
      </Field>

      <ScopePicker
        subjectName={subjectName}
        request={request}
        draft={draft}
        onDraftChange={setDraft}
        mode="expandable"
        phrasing="asking"
        // The FHIR server's patient/ support is too weak to rely on, so a device grant targets
        // all patients only — pin the subject and hide the one-patient / all-patients selector.
        forcedSubject="system"
      />

      <p className={styles['footnote']}>Only approve devices you recognize.</p>

      <ErrorBanner error={error} />

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
          // A fully-pruned draft serializes to no scopes, which the backend treats as a deny —
          // block the approve action rather than let an empty grant submit as an accidental denial.
          disabled={submitting || !GrantDraft.hasScopes(draft)}
          onClick={handleApprove}
        >
          Approve
        </button>
      </div>
    </>
  )
}

export { DeviceConsentCard }
export type { DeviceConsentCardProps, DeviceConsentMutation }
