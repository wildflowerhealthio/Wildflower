import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from 'react-kitchen-sink'
import {
  AsyncErrorView,
  Checkbox,
  Field,
  FieldDescription,
  pageLayoutStyles,
} from 'react-tundraish'

import {
  deviceConsentQueryOptions,
  useDeviceConsentMutation,
  useDeviceConsentQuery,
  type DeviceConsent,
} from '../../../queries.ts'
import { ensureAuthedQuery } from '../../../router-loader.ts'
import pageLayout from '../../../styles/page-layout.module.css'
import scopeListStyles from '../../../styles/scope-list.module.css'

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface DeviceConsentFormProps {
  readonly consent: DeviceConsent
  readonly onDone: () => void
}

const DeviceConsentForm = ({ consent, onDone }: DeviceConsentFormProps): JSX.Element => {
  const requestedScopes = consent.requestedScopes
  const consentMutation = useDeviceConsentMutation()
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<string>>(
    () => new Set(requestedScopes)
  )
  const [denied, setDenied] = useState(false)

  const submitting = consentMutation.isPending
  const mutationError = consentMutation.error === null ? null : formatError(consentMutation.error)
  const errorMessage = denied ? 'Authorization request was denied.' : mutationError

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
    setDenied(false)
    consentMutation.mutate(
      { kind: 'approve', userCode: consent.userCode, approvedScopes: [...selectedScopes] },
      {
        onSuccess: (result) => {
          if (result.status === 'approved') {
            onDone()
          } else {
            setDenied(true)
          }
        },
      }
    )
  }

  const handleDecline = (): void => {
    setDenied(false)
    consentMutation.mutate(
      { kind: 'deny', userCode: consent.userCode },
      {
        onSuccess: (result) => {
          if (result.status === 'denied' || result.status === 'approved') {
            onDone()
          }
        },
      }
    )
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
          className="button-2 filled accent-red"
          disabled={submitting}
          onClick={handleDecline}
        >
          Decline
        </button>
      </div>
    </div>
  )
}

const DeviceConsentScreen = ({ userCode }: { readonly userCode: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: consent } = useDeviceConsentQuery(userCode)
  return (
    <DeviceConsentForm
      consent={consent}
      onDone={() => {
        void navigate({ to: '/settings/gatekeeper' })
      }}
    />
  )
}

/**
 * The `/gatekeeper/devices/$userCode` file route. Reads the typed
 * `$userCode` path param from the generated route via `Route.useParams()`
 * and hands it to the screen as a prop. See {@link ensureAuthedQuery} for
 * the loader's token-ready guard and error-propagation contract.
 */
function DeviceConsentRoute(): JSX.Element {
  const { userCode } = Route.useParams()
  return <DeviceConsentScreen userCode={userCode} />
}

export const Route = createFileRoute('/_auth/gatekeeper/devices/$userCode')({
  loader: ({ context, params }) =>
    ensureAuthedQuery(context, deviceConsentQueryOptions(context.runAuthed, params.userCode)),
  component: DeviceConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Device Authorization" />,
})
