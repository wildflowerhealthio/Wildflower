import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from 'react-kitchen-sink'
import {
  Checkbox,
  Field,
  FieldDescription,
  FieldGroup,
  pageLayoutStyles,
  RadioGroup,
} from 'react-tundraish'

import { useOAuthConsentMutation } from '../../queries/index.ts'
import type { Consent } from './types.ts'
import { usePatientOptions } from './use-patient-options.ts'
import pageLayout from '../../styles/page-layout.module.css'
import scopeListStyles from '../../styles/scope-list.module.css'

interface OAuthConsentFormProps {
  readonly consent: Consent
  readonly onDone: () => void
}

const OAuthConsentForm = ({ consent, onDone }: OAuthConsentFormProps): JSX.Element => {
  const requestedScopes = consent.scopes
  const hasPatientScope = requestedScopes.some(
    (s) => s.startsWith('patient/') || s === 'launch/patient'
  )
  const consentMutation = useOAuthConsentMutation()
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<string>>(() =>
    consent.preApprovedScopes.length > 0
      ? new Set(consent.preApprovedScopes)
      : new Set(requestedScopes)
  )
  const [selectedPatient, setSelectedPatient] = useState<string>(consent.patient ?? '')
  const { options: patients } = usePatientOptions(hasPatientScope)
  const [resultError, setResultError] = useState<string | null>(null)

  const submitting = consentMutation.isPending
  const mutationError =
    consentMutation.error === null ? null : unknownErrorToString(consentMutation.error)
  const errorMessage = resultError ?? mutationError

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

  const handleApprove = (): void => {
    setResultError(null)
    consentMutation.mutate(
      {
        kind: 'approve',
        id: consent.id,
        payload: {
          approvedScopes: [...selectedScopes],
          patient: selectedPatient === '' ? null : selectedPatient,
        },
      },
      {
        onSuccess: (result) => {
          if (result.status === 'approved') {
            onDone()
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
            onDone()
          } else {
            setResultError(result.message)
          }
        },
      }
    )
  }

  return (
    <>
      <h1 className="text-heading-6">Authorization Request</h1>

      <Field label="Application">
        <span className="text-body-2">{consent.clientId}</span>
      </Field>

      <FieldGroup label="Requested Scopes">
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
      </FieldGroup>

      {hasPatientScope && patients.length > 0 ? (
        <>
          <FieldDescription>
            Choose which patient record to share with this application.
          </FieldDescription>
          {/* The native <fieldset> RadioGroup renders is the group; naming it
              via `legend` avoids the unnamed inner group a FieldGroup wrapper
              would nest it under. */}
          <RadioGroup
            legend="Patient Context"
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
        </>
      ) : null}

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
          className="button-2 outline"
          disabled={submitting}
          onClick={handleDecline}
        >
          Decline
        </button>
      </div>
    </>
  )
}

export { OAuthConsentForm }
export type { OAuthConsentFormProps }
