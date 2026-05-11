import type { HttpClient } from '@effect/platform'
import { Effect, type Layer, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Await, useNavigate } from 'react-router'
import { ItemList } from 'react-tundraish'
import { useEffectTs, webHttpClientLayer } from 'telemetry-react'

import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import { PageLoading } from '../components/PageLoading.tsx'
import { formatInstant } from '../format-date.ts'
import { useGatekeeperClientLayer } from '../use-gatekeeper-client-layer.ts'
import pageLayout from '../styles/page-layout.module.css'

type HttpRequest = Schema.Schema.Type<typeof AccessManagement.HttpRequestSchema>

type ClientLayer = Layer.Layer<GatekeeperHttpApiClient, never, HttpClient.HttpClient>

const RequestsListScreen = (): JSX.Element => {
  const layer = useGatekeeperClientLayer()
  const [refreshKey, setRefreshKey] = useState(0)

  const requestsEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) => c['access-management'].ListRequests()).pipe(
        Effect.provide(layer)
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [layer, refreshKey]
  )

  const requestsPromise = useEffectTs(requestsEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await resolve={requestsPromise} errorElement={<AsyncErrorView />}>
        {(requests: readonly HttpRequest[]) => (
          <RequestsListBody
            layer={layer}
            requests={requests}
            onDecided={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Await>
    </Suspense>
  )
}

interface RequestsListBodyProps {
  readonly layer: ClientLayer
  readonly requests: readonly HttpRequest[]
  readonly onDecided: () => void
}

const RequestsListBody = ({ layer, requests, onDecided }: RequestsListBodyProps): JSX.Element => {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  const decide = async (id: string, status: 'approved' | 'rejected'): Promise<void> => {
    try {
      const operation =
        status === 'approved'
          ? Effect.flatMap(GatekeeperHttpApiClient, (c) =>
              c['access-management'].ApproveRequest({ path: { id } })
            )
          : Effect.flatMap(GatekeeperHttpApiClient, (c) =>
              c['access-management'].DenyRequest({ path: { id } })
            )
      await Effect.runPromise(
        operation.pipe(Effect.provide(layer), Effect.provide(webHttpClientLayer))
      )
      onDecided()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toItem = (
    r: HttpRequest
  ): {
    id: string
    title: string
    subtitle: string
    onClick: () => void
    actions?: JSX.Element
  } => ({
    id: r.id,
    title: `${r.method} ${r.url}`,
    subtitle:
      r.origin !== ''
        ? `${r.origin} · ${formatInstant(r.requestedAt)}`
        : formatInstant(r.requestedAt),
    onClick: () => {
      void navigate(`/gatekeeper/requests/${encodeURIComponent(r.id)}`)
    },
    actions:
      r.status === 'pending' ? (
        <div className={pageLayout['row-actions']}>
          <button
            type="button"
            className="button-2 filled"
            onClick={(e) => {
              e.stopPropagation()
              void decide(r.id, 'approved')
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="button-2 filled accent-red"
            onClick={(e) => {
              e.stopPropagation()
              void decide(r.id, 'rejected')
            }}
          >
            Reject
          </button>
        </div>
      ) : undefined,
  })

  const pending = requests.filter((r) => r.status === 'pending')
  const approved = requests.filter((r) => r.status === 'approved')
  const rejected = requests.filter((r) => r.status === 'rejected')

  return (
    <div className={pageLayout['page']}>
      {error !== null ? <p className={cn(pageLayout['error'], 'text-body-3')}>{error}</p> : null}
      <ItemList title="In-Flight" items={pending.map((r) => toItem(r))} />
      <ItemList title="Approved" items={approved.map((r) => toItem(r))} />
      <ItemList title="Rejected" items={rejected.map((r) => toItem(r))} />
    </div>
  )
}

export { RequestsListScreen }
