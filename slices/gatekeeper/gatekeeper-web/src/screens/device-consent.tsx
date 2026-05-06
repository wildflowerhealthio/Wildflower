import type { Schema } from 'effect'
import type { Devices } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Checkbox } from 'react-tundraish'
import { runAuth } from '../client.ts'

type DeviceConsent = Schema.Schema.Type<typeof Devices.DeviceConsentSchema>

const DeviceConsentScreen = (): JSX.Element => {
  const { userCode = '' } = useParams<{ userCode: string }>()
  const navigate = useNavigate()
  const [consent, setConsent] = useState<DeviceConsent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (consent !== null) return () => undefined
    let cancelled = false
    void (async () => {
      try {
        const result = await runAuth((c) => c.devices.GetDeviceConsent({ path: { userCode } }))
        if (!cancelled) setConsent(result)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [userCode, consent])

  if (error !== null && consent === null) {
    return (
      <div className="gk-page">
        <h1 className="text-heading-4">Device Authorization</h1>
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
    <DeviceConsentForm
      consent={consent}
      onDone={() => {
        void navigate('/', { replace: true })
      }}
    />
  )
}

type DeviceConsentFormProps = {
  readonly consent: DeviceConsent
  readonly onDone: () => void
}

const DeviceConsentForm = ({ consent, onDone }: DeviceConsentFormProps): JSX.Element => {
  const requestedScopes = consent.requestedScopes
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<string>>(
    () => new Set(requestedScopes)
  )
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
      await runAuth((c) =>
        c.devices.ApproveDeviceConsent({
          path: { userCode: consent.userCode },
          payload: { approvedScopes: [...selectedScopes] },
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
      await runAuth((c) => c.devices.DenyDeviceConsent({ path: { userCode: consent.userCode } }))
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="gk-page">
      <h1 className="text-heading-4">Device Authorization</h1>

      <div className="gk-field">
        <span className="gk-field__label text-label-3">Code</span>
        <span className="text-body-2">
          <code>{consent.userCode}</code>
        </span>
      </div>

      <div className="gk-field">
        <span className="gk-field__label text-label-3">Application</span>
        <span className="text-body-2">{consent.clientName}</span>
        <span className="gk-field__description text-body-3">
          <code>{consent.clientId}</code>
        </span>
      </div>

      <div className="gk-field">
        <span className="gk-field__label text-label-3">Requested Scopes</span>
        <span className="gk-field__description text-body-3">
          Select which permissions to grant this device.
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

export { DeviceConsentScreen }
