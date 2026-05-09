import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { Devices } from 'gatekeeper-core/http-api-definition'

import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn, useEffectTs } from 'react-kitchen-sink'
import { Await, useNavigate, useParams } from 'react-router'
import { Checkbox } from 'react-tundraish'

import type { AuthenticatedSession } from '../client.ts'
import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import { Field, FieldDescription } from '../components/Field.tsx'
import { PageLoading } from '../components/PageLoading.tsx'
import { useGatekeeperClient } from '../use-gatekeeper-client.ts'
import pageLayout from '../styles/page-layout.module.css'
import scopeListStyles from '../styles/scope-list.module.css'

type DeviceConsent = Schema.Schema.Type<typeof Devices.DeviceConsentSchema>

/**
 * Suspense + `Await` pattern: the consent fetch is a single Effect
 * run through the session runtime, returning a stable Promise (via
 * `useEffectTs`). The form's approve/decline actions stay
 * imperative — they fire once on click, navigate away on success.
 */
const DeviceConsentScreen = (): JSX.Element => {
  const session = useGatekeeperClient()
  const navigate = useNavigate()
  const { userCode = '' } = useParams<{ userCode: string }>()

  const consentEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c.devices.GetDeviceConsent({ path: { userCode } })
      ),
    [userCode]
  )

  const consentPromise = useEffectTs(consentEffect, session.runtime)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await
        resolve={consentPromise}
        errorElement={<AsyncErrorView title="Device Authorization" />}
      >
        {(consent: DeviceConsent) => (
          <DeviceConsentForm
            session={session}
            consent={consent}
            onDone={() => {
              void navigate('/gatekeeper', { replace: true })
            }}
          />
        )}
      </Await>
    </Suspense>
  )
}

interface DeviceConsentFormProps {
  readonly session: AuthenticatedSession
  readonly consent: DeviceConsent
  readonly onDone: () => void
}

const DeviceConsentForm = ({ session, consent, onDone }: DeviceConsentFormProps): JSX.Element => {
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
      const result = await session.runPromise(
        Effect.flatMap(GatekeeperHttpApiClient, (c) =>
          c.devices.ApproveDeviceConsent({
            path: { userCode: consent.userCode },
            payload: { approvedScopes: [...selectedScopes] },
          })
        )
      )
      if (result.status === 'approved') {
        onDone()
      } else {
        setError('Authorization request was denied.')
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
          c.devices.DenyDeviceConsent({ path: { userCode: consent.userCode } })
        )
      )
      if (result.status === 'denied' || result.status === 'approved') {
        onDone()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={pageLayout['page']}>
      <h1 className="text-heading-4">Device Authorization</h1>

      <Field label="Code">
        <span className="text-body-2">
          <code>{consent.userCode}</code>
        </span>
      </Field>

      <Field label="Application">
        <span className="text-body-2">{consent.clientName}</span>
        <FieldDescription>
          <code>{consent.clientId}</code>
        </FieldDescription>
      </Field>

      <Field label="Requested Scopes">
        <FieldDescription>Select which permissions to grant this device.</FieldDescription>
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

      {error !== null ? <p className={cn(pageLayout['error'], 'text-body-3')}>{error}</p> : null}

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
