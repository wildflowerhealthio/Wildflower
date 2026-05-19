import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'

import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox, Field, FieldDescription, pageLayoutStyles, RadioGroup } from 'react-tundraish'

import type { GatekeeperEffectRunner } from '../../use-gatekeeper-effect-runner.ts'
import type { Consent } from './types.ts'
import { usePatientOptions } from './use-patient-options.ts'
import pageLayout from '../../styles/page-layout.module.css'
import scopeListStyles from '../../styles/scope-list.module.css'

interface OAuthConsentFormProps {
  readonly runGatekeeper: GatekeeperEffectRunner
  readonly consent: Consent
  readonly onDone: () => void
}

const OAuthConsentForm = ({
  runGatekeeper,
  consent,
  onDone,
}: OAuthConsentFormProps): JSX.Element => {
  const requestedScopes = consent.scopes
  const hasPatientScope = requestedScopes.some(
    (s) => s.startsWith('patient/') || s === 'launch/patient'
  )
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<string>>(() =>
    consent.preApprovedScopes.length > 0
      ? new Set(consent.preApprovedScopes)
      : new Set(requestedScopes)
  )
  const [selectedPatient, setSelectedPatient] = useState<string>(consent.patient ?? '')
  const { options: patients } = usePatientOptions(hasPatientScope)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleScope = (scope: string): void => {
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

  const handleApprove = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await runGatekeeper(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c['oauth-consent'].ApproveOAuthConsent({
            path: { id: consent.id },
            payload: {
              approvedScopes: [...selectedScopes],
              patient: selectedPatient === '' ? null : selectedPatient,
            },
          })
        )
      )
      if (result.status === 'approved') {
        onDone()
      } else if (result.status === 'denied') {
        setError('Authorization request was denied.')
      } else {
        setError(result.message)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDecline = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await runGatekeeper(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c['oauth-consent'].DenyOAuthConsent({
            path: { id: consent.id },
          })
        )
      )
      if (result.status === 'denied' || result.status === 'approved') {
        onDone()
      } else {
        setError(result.message)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-4">Authorization Request</h1>

      <Field label="Application">
        <span className="text-body-2">{consent.clientId}</span>
      </Field>

      <Field label="Requested Scopes">
        <FieldDescription>Select which permissions to grant this application.</FieldDescription>
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

      {hasPatientScope && patients.length > 0 ? (
        <Field label="Patient Context">
          <FieldDescription>
            Choose which patient record to share with this application.
          </FieldDescription>
          <RadioGroup
            name="patient"
            value={selectedPatient}
            onChange={setSelectedPatient}
            options={[
              { value: '', label: 'No patient context' },
              ...patients.map((p) => ({
                value: p.id,
                label: (
                  <>
                    {p.displayName} <code>{p.id}</code>
                  </>
                ),
              })),
            ]}
          />
        </Field>
      ) : null}

      {error !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{error}</p>
      ) : null}

      <div className={pageLayout['buttons']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={selectedScopes.size === 0 || submitting}
          onClick={() => {
            void handleApprove()
          }}
        >
          {selectedScopes.size < requestedScopes.length
            ? `Approve (${selectedScopes.size}/${requestedScopes.length})`
            : 'Approve'}
        </button>
        <button
          type="button"
          className="button-2 outline"
          disabled={submitting}
          onClick={() => {
            void handleDecline()
          }}
        >
          Decline
        </button>
      </div>
    </div>
  )
}

export { OAuthConsentForm }
export type { OAuthConsentFormProps }
