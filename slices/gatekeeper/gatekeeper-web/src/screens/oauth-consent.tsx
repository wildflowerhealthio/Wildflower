import type { Schema } from 'effect'
import type { OAuthConsent } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Checkbox, RadioGroup } from 'react-tundraish'
import { runAuth } from '../client.ts'

type Consent = Schema.Schema.Type<typeof OAuthConsent.OAuthConsentSchema>

type PatientOption = { readonly id: string; readonly displayName: string }

type FhirName = { readonly given?: readonly string[]; readonly family?: string }
type FhirPatientResource = {
  readonly id?: string
  readonly name?: readonly FhirName[]
}
type FhirBundleEntry = { readonly resource?: FhirPatientResource }
type FhirBundle = { readonly entry?: readonly FhirBundleEntry[] }

const fetchPatientOptions = async (): Promise<readonly PatientOption[]> => {
  const res = await fetch('/fhir-r4/Patient')
  if (!res.ok) throw new Error(`Fetch patients failed: ${res.status}`)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const bundle = (await res.json()) as FhirBundle
  return (bundle.entry ?? []).flatMap((e): PatientOption[] => {
    const resource = e.resource
    if (resource === undefined || resource.id === undefined) return []
    const name = resource.name?.[0]
    const given = name?.given?.join(' ') ?? ''
    const family = name?.family ?? ''
    const joined = [given, family].filter((s) => s !== '').join(' ')
    return [{ id: resource.id, displayName: joined !== '' ? joined : resource.id }]
  })
}

const OAuthConsentScreen = (): JSX.Element => {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [consent, setConsent] = useState<Consent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (consent !== null) return () => undefined
    let cancelled = false
    void (async () => {
      try {
        const result = await runAuth((c) => c['oauth-consent'].GetOAuthConsent({ path: { id } }))
        if (!cancelled) setConsent(result)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, consent])

  if (error !== null) {
    return (
      <div className="gk-page">
        <h1 className="text-heading-4">Authorization Request</h1>
        <p className="gk-error text-body-3">{error}</p>
      </div>
    )
  }
  if (consent === null) {
    return (
      <div className="gk-page">
        <p className="text-body-2">Loading…</p>
      </div>
    )
  }

  return (
    <OAuthConsentForm
      consent={consent}
      onDone={() => {
        void navigate('/', { replace: true })
      }}
    />
  )
}

type OAuthConsentFormProps = { readonly consent: Consent; readonly onDone: () => void }

const OAuthConsentForm = ({ consent, onDone }: OAuthConsentFormProps): JSX.Element => {
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
  const [patients, setPatients] = useState<readonly PatientOption[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hasPatientScope) return () => undefined
    let cancelled = false
    void (async () => {
      try {
        const options = await fetchPatientOptions()
        if (!cancelled) setPatients(options)
      } catch {
        // Leave patients empty; user can still approve without patient context
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hasPatientScope])

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
      await runAuth((c) =>
        c['oauth-consent'].ApproveOAuthConsent({
          path: { id: consent.id },
          payload: {
            approvedScopes: [...selectedScopes],
            patient: selectedPatient === '' ? null : selectedPatient,
          },
        })
      )
      onDone()
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
      await runAuth((c) =>
        c['oauth-consent'].DenyOAuthConsent({
          path: { id: consent.id },
        })
      )
      onDone()
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

export { OAuthConsentScreen }
