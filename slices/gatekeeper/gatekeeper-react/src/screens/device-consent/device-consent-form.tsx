/**
 * Shared device-consent form, reused by:
 *
 *  - the standalone `/gatekeeper/devices/:userCode` route, which
 *    navigates away on `onDone`, and
 *  - the in-app {@link DeviceConsentModalHost} popup (Tauri only),
 *    which closes the modal on `onDone`, and
 *  - the in-settings `/settings/gatekeeper/devices/:userCode` route,
 *    which additionally lets the approver rename the device
 *    (`editableName`).
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

import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { Field, FieldDescription, pageLayoutStyles, TextField } from 'react-tundraish'
import { GrantDraft, ScopeRequest } from 'scopes-core'
import { ScopePicker } from 'scopes-react'

import { useDeviceConsentMutation, type DeviceConsent } from '../../queries/index.ts'
import { usePatientOptions } from '../oauth-consent/use-patient-options.ts'
import styles from './device-consent-form.module.css'

interface DeviceConsentFormProps {
  readonly consent: DeviceConsent
  readonly onDone: () => void
  /** When true (the settings surface), the approver may rename the device before approving. */
  readonly editableName?: boolean
}

const DeviceConsentForm = ({
  consent,
  onDone,
  editableName = false,
}: DeviceConsentFormProps): JSX.Element => {
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
  const [name, setName] = useState(consent.deviceName ?? '')
  const [denied, setDenied] = useState(false)
  // The account's patients feed the picker's "Just one patient" choice (a UI-only
  // selection for now — the approved grant still carries plain `patient/` scopes).
  const { options: patients } = usePatientOptions(true)

  const submitting = consentMutation.isPending
  const mutationError =
    consentMutation.error === null ? null : unknownErrorToString(consentMutation.error)
  // A genuine mutation failure takes precedence over a stale "denied" flag.
  const errorMessage = mutationError ?? (denied ? 'Authorization request was denied.' : null)

  // The statement subject: the device's (possibly just-edited) name, falling back to the
  // registered client name. Two-step so the naming policy reads plainly:
  //  1. the device name in play here — the approver's edit on the settings surface,
  //     otherwise whatever the device supplied at pairing;
  //  2. that, or the registered client name when no device name is available.
  const trimmedName = name.trim()
  const enteredDeviceName = editableName ? trimmedName : (consent.deviceName ?? '')
  const subjectName = enteredDeviceName || consent.clientName

  // The device-name control: an editable field on the settings surface, a read-only line
  // elsewhere (only when the device actually named itself).
  const renderDeviceName = (): JSX.Element | null => {
    if (editableName) {
      return (
        <TextField
          label="Device name"
          value={name}
          onChange={setName}
          placeholder="e.g. Ada's laptop"
          autoCapitalize="words"
        />
      )
    }
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
        // Only send an adjusted name from the settings surface, and only when non-empty —
        // an omitted name keeps whatever the device supplied (server-side COALESCE).
        ...(editableName && trimmedName !== '' ? { deviceName: trimmedName } : {}),
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
      />

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
