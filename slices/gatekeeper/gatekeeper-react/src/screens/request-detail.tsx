import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'

import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Await, useParams } from 'react-router'
import {
  AsyncErrorView,
  pageLayoutStyles,
  PageLoading,
  StatusBadge,
  type StatusTone,
} from 'react-tundraish'

import { formatInstant } from '../format-date.ts'
import {
  useGatekeeperEffectRunner,
  type GatekeeperEffectRunner,
} from '../use-gatekeeper-effect-runner.ts'
import { useGatekeeperEffect } from '../use-gatekeeper-effect.ts'
import pageLayout from '../styles/page-layout.module.css'

type HttpRequest = Schema.Schema.Type<typeof AccessManagement.HttpRequestSchema>

const statusTone = (status: string): StatusTone => {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'danger'
  if (status === 'pending') return 'warning'
  return 'neutral'
}

const RequestDetailScreen = (): JSX.Element => {
  const runGatekeeper = useGatekeeperEffectRunner()
  const { id = '' } = useParams<{ id: string }>()
  const [refreshKey, setRefreshKey] = useState(0)

  const requestEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c['access-management'].GetRequest({ path: { id } })
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [id, refreshKey]
  )

  const requestPromise = useGatekeeperEffect(requestEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await resolve={requestPromise} errorElement={<AsyncErrorView title="Not Found" />}>
        {(request: HttpRequest) => (
          <RequestDetailBody
            runGatekeeper={runGatekeeper}
            request={request}
            id={id}
            onDecided={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Await>
    </Suspense>
  )
}

interface RequestDetailBodyProps {
  readonly runGatekeeper: GatekeeperEffectRunner
  readonly request: HttpRequest
  readonly id: string
  readonly onDecided: () => void
}

const RequestDetailBody = ({
  runGatekeeper,
  request,
  id,
  onDecided,
}: RequestDetailBodyProps): JSX.Element => {
  const [error, setError] = useState<string | null>(null)

  const decide = async (status: 'approved' | 'rejected'): Promise<void> => {
    try {
      const operation =
        status === 'approved'
          ? Effect.flatMap(GatekeeperHttpApiClient, (c) =>
              c['access-management'].ApproveRequest({ path: { id } })
            )
          : Effect.flatMap(GatekeeperHttpApiClient, (c) =>
              c['access-management'].DenyRequest({ path: { id } })
            )
      await runGatekeeper(operation)
      onDecided()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className={pageLayoutStyles['page']}>
      <div className={pageLayout['section']}>
        <h2 className="text-label-3">{request.method}</h2>
        <h1 className="text-heading-4">{request.url}</h1>
      </div>

      <StatusBadge tone={statusTone(request.status)}>{request.status.toUpperCase()}</StatusBadge>

      <div className={pageLayout['section']}>
        <strong className="text-label-3">Request</strong>
        <span className="text-body-3">Received: {formatInstant(request.requestedAt)}</span>
        {request.origin !== '' ? (
          <span className="text-body-3">Origin: {request.origin}</span>
        ) : null}
        {request.userAgent !== '' ? (
          <span className="text-body-3">User-Agent: {request.userAgent}</span>
        ) : null}
      </div>

      {request.respondedAt !== null ? (
        <div className={pageLayout['section']}>
          <strong className="text-label-3">Response</strong>
          <span className="text-body-3">Responded: {formatInstant(request.respondedAt)}</span>
          {request.statusCode !== null ? (
            <span className="text-body-3">Status: {request.statusCode}</span>
          ) : null}
        </div>
      ) : null}

      {request.status === 'pending' ? (
        <div className={pageLayout['buttons']}>
          <button
            type="button"
            className="button-2 filled"
            onClick={() => {
              void decide('approved')
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="button-2 filled accent-red"
            onClick={() => {
              void decide('rejected')
            }}
          >
            Reject
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{error}</p>
      ) : null}
    </div>
  )
}

export { RequestDetailScreen }
