import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Await, useNavigate } from 'react-router'
import { AsyncErrorView, ItemList, pageLayoutStyles, PageLoading } from 'react-tundraish'

import { formatInstant } from '../format-date.ts'
import {
  useGatekeeperEffect,
  useGatekeeperEffectAction,
  type GatekeeperEffectAction,
} from '../gatekeeper-client.tsx'
import pageLayout from '../styles/page-layout.module.css'

type HttpRequest = Schema.Schema.Type<typeof AccessManagement.HttpRequestSchema>

const RequestsListScreen = (): JSX.Element => {
  const runGatekeeper = useGatekeeperEffectAction()
  const [refreshKey, setRefreshKey] = useState(0)

  const requestsEffect = useMemo(
    () => Effect.flatMap(GatekeeperHttpApiClient, (c) => c['access-management'].ListRequests()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const requestsPromise = useGatekeeperEffect(requestsEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await resolve={requestsPromise} errorElement={<AsyncErrorView />}>
        {(requests: readonly HttpRequest[]) => (
          <RequestsListBody
            runGatekeeper={runGatekeeper}
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
  readonly runGatekeeper: GatekeeperEffectAction
  readonly requests: readonly HttpRequest[]
  readonly onDecided: () => void
}

const RequestsListBody = ({
  runGatekeeper,
  requests,
  onDecided,
}: RequestsListBodyProps): JSX.Element => {
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
      await runGatekeeper(operation)
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
      void navigate(`/settings/gatekeeper/requests/${encodeURIComponent(r.id)}`)
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
    <div className={pageLayoutStyles['page']}>
      {error !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')}>{error}</p>
      ) : null}
      <ItemList title="In-Flight" items={pending.map((r) => toItem(r))} />
      <ItemList title="Approved" items={approved.map((r) => toItem(r))} />
      <ItemList title="Rejected" items={rejected.map((r) => toItem(r))} />
    </div>
  )
}

export { RequestsListScreen }
