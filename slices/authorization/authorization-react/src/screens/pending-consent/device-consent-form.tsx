/**
 * The device-consent form of the standalone `/authorization/devices/:userCode`
 * route, which navigates away on `onDone`.
 *
 * The device-code consent is **expandable**: the owner edits the request through
 * the shared {@link ScopePicker} in `expandable` mode, so they can add scopes the
 * device didn't request (up to the client's `allowedScopes`) as well as prune
 * them. The submitted grant is whatever the draft serializes to.
 *
 * Renders the design-system "device authorization" card; its skin lives in
 * `device-consent-form.module.css` (token-driven). The surrounding chrome
 * (page shell + `PageHeader`, or the `Dialog`) is the caller's.
 */

import { ErrorBanner, Field, FieldDescription } from '@wildflowerhealthio/react-tundraish'
import { GrantDraft, ScopeRequest } from '@wildflowerhealthio/scopes-core'
import { ScopePicker } from '@wildflowerhealthio/scopes-react'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'

import { useDeviceConsentMutation, type DeviceConsent } from '../../queries/index.ts'
import { usePatientOptions } from '../oauth-consent/use-patient-options.ts'
import styles from './device-consent-form.module.css'

interface DeviceConsentFormProps {
  readonly consent: DeviceConsent
  readonly onDone: () => void
}

const DeviceConsentForm = ({ consent, onDone }: DeviceConsentFormProps): JSX.Element => {
  const consentMutation = useDeviceConsentMutation()

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
  // The account's patients feed the picker's "Just one patient" choice (a UI-only
  // selection for now — the approved grant still carries plain `patient/` scopes).
  const { options: patients } = usePatientOptions(true)

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
        patients={patients}
        // The FHIR server's patient/ support is too weak to rely on, so a device grant targets
        // all patients only — pin the subject and hide the one-patient / all-patients selector.
        forcedSubject="system"
      />

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

      <p className={styles['footnote']}>Only approve devices you recognize.</p>
    </>
  )
}

export { DeviceConsentForm }
export type { DeviceConsentFormProps }
