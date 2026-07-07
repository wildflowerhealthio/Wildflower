import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { pageLayoutStyles, StatusBadge } from 'react-tundraish'
import { GrantDraft, Scope, ScopeRequest } from 'scopes-core'
import type { GrantDraft as GrantDraftModel } from 'scopes-core'
import { PatientPillPicker, ScopePicker } from 'scopes-react'

import { useOAuthConsentMutation } from '../../queries/index.ts'
import type { OAuthConsentResource, OAuthConsentResult } from '../../queries/index.ts'
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
  // is requested.
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
  const { options: patients } = usePatientOptions(hasPatientScope)

  const serialized = useMemo(() => GrantDraft.serializeAll(draft), [draft])

  const submitting = consentMutation.isPending
  const mutationError =
    consentMutation.error === null ? null : unknownErrorToString(consentMutation.error)
  const errorMessage = resultError ?? mutationError

  const handleApprove = (): void => {
    setResultError(null)
    consentMutation.mutate(
      {
        kind: 'approve',
        id: consent.id,
        payload: { approvedScopes: serialized, patient: draft.patient },
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
        <div aria-hidden="true" className={styles['avatar']}>
          {appName.slice(0, 1).toUpperCase()}
        </div>
        <div className={styles['identity']}>
          <h2 className={styles['name']}>{appName}</h2>
          <p className={styles['subtitle']}>wants to connect to your health records</p>
          <code className={styles['client-id']}>{consent.clientId}</code>
        </div>
        <StatusBadge tone="info">Review request</StatusBadge>
      </header>

      {hasPatientScope && patients.length > 0 ? (
        <div className={styles['patient-bar']}>
          <p className={styles['eyebrow']}>Patient</p>
          <PatientPillPicker
            patients={patients}
            value={draft.patient}
            onChange={(patientId) => {
              setDraft((previous) => ({ ...previous, patient: patientId }))
            }}
          />
        </div>
      ) : null}

      <ScopePicker subjectName={appName} request={request} draft={draft} onDraftChange={setDraft} />

      <div className={styles['footer']}>
        {errorMessage !== null ? (
          <p className={cn(pageLayoutStyles['error'], styles['error'], 'text-body-3')} role="alert">
            {errorMessage}
          </p>
        ) : null}

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
            disabled={serialized.length === 0 || submitting}
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
