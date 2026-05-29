/* oxlint-disable react/only-export-components, typescript/no-unsafe-assignment -- typed via createFileRoute and a slice-local routeTree.gen.ts augmentation; oxlint type inference does not pick it up */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { Devices } from 'gatekeeper-core/http-api-definition'

import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import {
  Awaited,
  Checkbox,
  Field,
  FieldDescription,
  pageLayoutStyles,
  PageLoading,
} from 'react-tundraish'

import {
  useGatekeeperEffect,
  useGatekeeperEffectAction,
  type GatekeeperEffectAction,
} from '../../../gatekeeper-client.tsx'
import pageLayout from '../../../styles/page-layout.module.css'
import scopeListStyles from '../../../styles/scope-list.module.css'

type DeviceConsent = Schema.Schema.Type<typeof Devices.DeviceConsentSchema>

function DeviceConsentScreen(): JSX.Element {
  const runGatekeeper = useGatekeeperEffectAction()
  const navigate = useNavigate()
  const { userCode } = Route.useParams()

  const consentEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c.devices.GetDeviceConsent({ path: { userCode } })
      ),
    [userCode]
  )

  const consentPromise = useGatekeeperEffect(consentEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Awaited promise={consentPromise} resetKey={userCode} errorTitle="Device Authorization">
        {(consent) => (
          <DeviceConsentForm
            runGatekeeper={runGatekeeper}
            consent={consent}
            onDone={() => {
              void navigate({ to: '/settings/gatekeeper' })
            }}
          />
        )}
      </Awaited>
    </Suspense>
  )
}

interface DeviceConsentFormProps {
  readonly runGatekeeper: GatekeeperEffectAction
  readonly consent: DeviceConsent
  readonly onDone: () => void
}

const DeviceConsentForm = ({
  runGatekeeper,
  consent,
  onDone,
}: DeviceConsentFormProps): JSX.Element => {
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
      const result = await runGatekeeper(
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
      const result = await runGatekeeper(
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
    <div className={pageLayoutStyles['page']}>
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

export const Route = createFileRoute('/gatekeeper/devices/$userCode')({
  component: DeviceConsentScreen,
})
