import type { Schema } from 'effect'
import type { AuthorizationRequest } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Checkbox, RadioGroup } from 'react-tundraish'
import { runAuth } from '../client.ts'
import { clearInitial, readInitial } from '../data/initial.ts'

type AnyAuthRequest = Schema.Schema.Type<typeof AuthorizationRequest.AuthorizationRequestSchema>
type OAuth2Request = Extract<AnyAuthRequest, { _tag: 'oauth2' }>
type PinRequest = Extract<AnyAuthRequest, { _tag: 'pin_cookie' }>

type AuthRequest = OAuth2Request | PinRequest

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

const AuthorizationRequestScreen = (): JSX.Element => {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [request, setRequest] = useState<AuthRequest | null>(() => {
    const initial = readInitial<AuthRequest>()
    clearInitial()
    return initial
  })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (request !== null) return () => undefined
    let cancelled = false
    void (async () => {
      try {
        const result = await runAuth((c) =>
          c['authorization-request'].GetAuthorizationRequest({ path: { id } })
        )
        if (!cancelled) setRequest(result)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, request])

  if (error !== null) {
    return (
      <div className="gk-page">
        <h1 className="text-heading-4">Authorization Request</h1>
        <p className="gk-error text-body-3">{error}</p>
      </div>
    )
  }
  if (request === null) {
    return (
      <div className="gk-page">
        <p className="text-body-2">Loading…</p>
      </div>
    )
  }

  if (request._tag === 'oauth2') {
    return (
      <OAuthForm
        request={request}
        onDone={() => {
          void navigate('/', { replace: true })
        }}
      />
    )
  }
  return (
    <PinForm
      id={request.id}
      onDone={() => {
        void navigate('/', { replace: true })
      }}
    />
  )
}

type OAuthFormProps = { readonly request: OAuth2Request; readonly onDone: () => void }

const OAuthForm = ({ request, onDone }: OAuthFormProps): JSX.Element => {
  const requestedScopes = request.scopes
  const hasPatientScope = requestedScopes.some(
    (s) => s.startsWith('patient/') || s === 'launch/patient'
  )
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<string>>(() =>
    request.preApprovedScopes.length > 0
      ? new Set(request.preApprovedScopes)
      : new Set(requestedScopes)
  )
  const [selectedPatient, setSelectedPatient] = useState<string>('')
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
        c['authorization-request'].PatchAuthorizationRequest({
          path: { id: request.id },
          payload: {
            _tag: 'oauth2',
            status: 'approved',
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
        c['authorization-request'].PatchAuthorizationRequest({
          path: { id: request.id },
          payload: { _tag: 'oauth2', status: 'denied' },
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
        <span className="text-body-2">{request.clientId}</span>
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

type PinFormProps = { readonly id: string; readonly onDone: () => void }

type PinDuration = 'request' | '1min' | '15min'

const PIN_DURATIONS: readonly { readonly value: PinDuration; readonly label: string }[] = [
  { value: 'request', label: 'Just this request' },
  { value: '1min', label: '1 minute' },
  { value: '15min', label: '15 minutes' },
]

const PinForm = ({ id, onDone }: PinFormProps): JSX.Element => {
  const [pin, setPin] = useState('')
  const [duration, setDuration] = useState<PinDuration>('request')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleApprove = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await runAuth((c) =>
        c['authorization-request'].PatchAuthorizationRequest({
          path: { id },
          payload: { _tag: 'pin_cookie', status: 'approved', pin, duration },
        })
      )
      if (result.status === 'invalid_pin') {
        setError('Incorrect PIN. Please try again.')
        setPin('')
        return
      }
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
        c['authorization-request'].PatchAuthorizationRequest({
          path: { id },
          payload: { _tag: 'pin_cookie', status: 'denied' },
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
      <h1 className="text-heading-4">Access Request</h1>
      <p className="gk-field__description text-body-3">
        Someone is requesting access. Enter the PIN shown to them to verify.
      </p>

      <div className="gk-field">
        <span className="gk-field__label text-label-3">PIN</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          className={['gk-pin-input', error !== null ? 'gk-pin-input--error' : null]
            .filter((c) => c !== null)
            .join(' ')}
          value={pin}
          maxLength={6}
          placeholder="000000"
          autoFocus
          onChange={(e) => {
            setPin(e.target.value.replace(/[^0-9]/g, ''))
            if (error !== null) setError(null)
          }}
        />
        {error !== null ? <p className="gk-error text-body-3">{error}</p> : null}
      </div>

      <div className="gk-field">
        <span className="gk-field__label text-label-3">Grant Access For</span>
        <RadioGroup
          name="duration"
          value={duration}
          onChange={setDuration}
          options={PIN_DURATIONS.map((d) => ({ value: d.value, label: d.label }))}
        />
      </div>

      <div className="gk-buttons">
        <button
          type="button"
          className="button-2 filled"
          disabled={pin.length !== 6 || submitting}
          onClick={() => {
            void handleApprove()
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className="button-2 filled accent-red"
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

export { AuthorizationRequestScreen }
