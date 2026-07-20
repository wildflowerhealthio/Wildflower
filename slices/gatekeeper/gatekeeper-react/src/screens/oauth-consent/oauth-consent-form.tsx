import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, pageLayoutStyles, StatusBadge } from 'react-tundraish'
import { GrantDraft, Scope, ScopeRequest } from 'scopes-core'
import type { GrantDraft as GrantDraftModel } from 'scopes-core'
import { PatientPillPicker, ScopePicker } from 'scopes-react'

import { useOAuthConsentMutation } from '../../queries/index.ts'
import type { OAuthConsentResource, OAuthConsentResult } from '../../queries/index.ts'
import { AppAvatar } from './app-avatar.tsx'
import { usePatientOptions } from './use-patient-options.ts'
import styles from '../../styles/consent-card.module.css'

interface OAuthConsentFormProps {
  readonly consent: OAuthConsentResource
  readonly onDone: (result: OAuthConsentResult) => void
}

/**
 * The OAuth consent card: the app-identity header, the launch-patient bar, the shared
 * {@link ScopePicker} editing surface, and the approve/deny decision wiring. The scope
 * editing itself (statements ⇄ grid, exclusions, flags) is `scopes-react`'s; this form
 * owns the draft, the consent mutation, and the result routing.
 */
const OAuthConsentForm = ({ consent, onDone }: OAuthConsentFormProps): JSX.Element => {
  const request = useMemo(
    () => ScopeRequest.fromRequestedScopes({ optional: consent.scopes }),
    [consent]
  )

  // The app's display identity: the registered client name, with the raw
  // client_id demoted to a small mono line (and doubling as the fallback
  // subject when registration didn't carry a name).
  const appName = consent.clientName === '' ? consent.clientId : consent.clientName

  // The launch-patient picker matters when a FHIR patient-context scope or `launch/patient`
  // is *requested* — this gates the (request-scoped) patient options fetch, so the list is
  // ready regardless of how the user later prunes the draft.
  const hasPatientScope = useMemo(
    () =>
      Scope.MultiScope.fhirScopes(request.requested).some((scope) =>
        scope.hasContext(Scope.Contexts.Fhir.patient)
      ) || request.requested.known.some((known) => known.name === 'launch/patient'),
    [request]
  )

  const consentMutation = useOAuthConsentMutation()
  // Deliberate behavior change: seed every *requested* scope as granted (not just the
  // pre-approved subset) — the user prunes rather than builds.
  const [draft, setDraft] = useState<GrantDraftModel.GrantDraft>(() =>
    GrantDraft.fromScopes(consent.scopes, consent.patient ?? null)
  )
  const [resultError, setResultError] = useState<string | null>(null)
  const [patientError, setPatientError] = useState<string | null>(null)
  const { options: patients } = usePatientOptions(hasPatientScope)

  // Whether a patient-context scope is still granted in the *current draft*. The
  // requirement to supply a launch patient tracks this, not the original request:
  // if the user prunes every patient-context scope, the picker disappears and no
  // patient is needed (and none is sent). While any patient scope remains, a
  // patient must be chosen — so the picker offers no "no patient" escape hatch.
  const draftHasPatientScope = useMemo(
    () =>
      Scope.MultiScope.fhirScopes(draft).some((scope) =>
        scope.hasContext(Scope.Contexts.Fhir.patient)
      ) || draft.known.some((known) => known.name === 'launch/patient'),
    [draft]
  )

  const patientBarRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  const patientPickerShown = draftHasPatientScope && patients.length > 0

  const submitting = consentMutation.isPending
  // A result message (a denial / result error) takes precedence over the raw
  // mutation error; `ErrorBanner` renders whichever is set (a `403` — unreachable
  // on the consent surface, but handled uniformly — as the permission surface).
  const error = resultError ?? consentMutation.error
  const hasError = resultError !== null || consentMutation.error !== null

  // The error banner sits at the top of the card, but the buttons that trigger
  // it are at the bottom — scroll it into view whenever it appears so a
  // scrolled-down user sees why their approval/denial didn't go through.
  useEffect(() => {
    if (hasError) {
      errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [hasError])

  const handleApprove = (): void => {
    setResultError(null)
    // A patient-context request needs a launch patient — surface the miss
    // beside the picker instead of sending a patientless approval.
    if (patientPickerShown && draft.patient === null) {
      setPatientError('Select a patient to continue.')
      patientBarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    consentMutation.mutate(
      {
        kind: 'approve',
        id: consent.id,
        payload: {
          approvedScopes: GrantDraft.serializeAll(draft),
          // Only bind a launch patient when the draft still grants a patient-context
          // scope; a patient chosen before pruning all patient scopes is dropped.
          patient: draftHasPatientScope ? draft.patient : null,
        },
      },
      {
        onSuccess: (result) => {
          if (result.status === 'approved') {
            onDone(result)
          } else if (result.status === 'denied') {
            setResultError('Authorization request was denied.')
          } else {
            setResultError(result.message)
          }
        },
      }
    )
  }

  const handleDecline = (): void => {
    setResultError(null)
    consentMutation.mutate(
      { kind: 'deny', id: consent.id },
      {
        onSuccess: (result) => {
          if (result.status === 'denied' || result.status === 'approved') {
            onDone(result)
          } else {
            setResultError(result.message)
          }
        },
      }
    )
  }

  return (
    <section className={styles['card']}>
      <header className={styles['header']}>
        <AppAvatar name={appName} redirectUri={consent.redirectUri} />
        <div className={styles['identity']}>
          <h2 className={styles['name']}>{appName}</h2>
          <p className={styles['subtitle']}>wants to connect to your health records</p>
          <code className={styles['client-id']}>{consent.clientId}</code>
        </div>
        <StatusBadge tone="info">Review request</StatusBadge>
      </header>

      {hasError ? (
        <div ref={errorRef} className={styles['result-error']}>
          <ErrorBanner error={error} />
        </div>
      ) : null}

      {patientPickerShown ? (
        <div className={styles['patient-bar']} ref={patientBarRef}>
          <p className={styles['eyebrow']}>Patient</p>
          <PatientPillPicker
            patients={patients}
            value={draft.patient}
            onChange={(patientId) => {
              setPatientError(null)
              setDraft((previous) => ({ ...previous, patient: patientId }))
            }}
          />
          {patientError !== null ? (
            <p
              className={cn(pageLayoutStyles['error'], styles['patient-error'], 'text-body-3')}
              role="alert"
            >
              {patientError}
            </p>
          ) : null}
        </div>
      ) : null}

      <ScopePicker subjectName={appName} request={request} draft={draft} onDraftChange={setDraft} />

      <div className={styles['footer']}>
        <div className={styles['buttons']}>
          <button
            type="button"
            className={cn('button-2 outline accent-red', styles['deny'])}
            disabled={submitting}
            onClick={handleDecline}
          >
            Deny
          </button>
          <button
            type="button"
            className={cn('button-2 filled', styles['allow'])}
            // A fully-pruned draft serializes to no scopes, which the backend
            // treats as a deny — block the approve action rather than let an
            // empty grant submit as an accidental denial.
            disabled={submitting || !GrantDraft.hasScopes(draft)}
            onClick={handleApprove}
          >
            Allow access
          </button>
        </div>
      </div>
    </section>
  )
}

export { OAuthConsentForm }
export type { OAuthConsentFormProps }
