import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { useState, type JSX } from 'react'
import { Checkbox, RadioGroup } from 'react-tundraish'

import type { AuthenticatedSession } from '../../client.ts'
import type { Consent } from './types.ts'
import { usePatientOptions } from './use-patient-options.ts'

interface OAuthConsentFormProps {
  readonly session: AuthenticatedSession
  readonly consent: Consent
  readonly onDone: () => void
}

const OAuthConsentForm = ({ session, consent, onDone }: OAuthConsentFormProps): JSX.Element => {
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
  const { options: patients } = usePatientOptions(session, hasPatientScope)
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
      const result = await session.runPromise(
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
      const result = await session.runPromise(
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
    <div className="gk-page">
      <h1 className="text-heading-4">Authorization Request</h1>

      <div className="gk-field">
        <span className="gk-field__label text-label-3">Application</span>
        <span className="text-body-2">{consent.clientId}</span>
      </div>

      <div className="gk-field">
        <span className="gk-field__label text-label-3">Requested Scopes</span>
        <span className="gk-field__description text-body-3">
          Select which permissions to grant this application.
        </span>
        <div className="gk-scope-list">
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
      </div>

      {hasPatientScope && patients.length > 0 ? (
        <div className="gk-field">
          <span className="gk-field__label text-label-3">Patient Context</span>
          <span className="gk-field__description text-body-3">
            Choose which patient record to share with this application.
          </span>
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
        </div>
      ) : null}

      {error !== null ? <p className="gk-error text-body-3">{error}</p> : null}

      <div className="gk-buttons">
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
