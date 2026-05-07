import { Effect, type Schema } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import type { AccessManagement } from 'gatekeeper-core/http-api-definition'
import { cn } from 'kitchen-sink'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { useEffectTs } from 'react-kitchen-sink'
import { Await, useNavigate } from 'react-router'
import { ItemList } from 'react-tundraish'

import type { AuthenticatedSession } from '../client.ts'
import { AsyncErrorView } from '../components/AsyncErrorView.tsx'
import { PageLoading } from '../components/PageLoading.tsx'
import { formatInstant } from '../format-date.ts'
import { useGatekeeperClient } from '../use-gatekeeper-client.ts'
import pageLayout from '../styles/page-layout.module.css'

type HttpRequest = Schema.Schema.Type<typeof AccessManagement.HttpRequestSchema>

/**
 * Suspense + `Await` pattern: the list fetch is a single Effect
 * routed through `useEffectTs`. Per-row Approve/Reject actions
 * bump a `refreshKey` so the list re-fetches and the row
 * disappears from "In-Flight" once the server responds.
 */
const RequestsListScreen = (): JSX.Element => {
  const session = useGatekeeperClient()
  const [refreshKey, setRefreshKey] = useState(0)

  const requestsEffect = useMemo(
    () => Effect.flatMap(GatekeeperHttpApiClient, (c) => c['access-management'].ListRequests()),
    // refreshKey is the explicit re-fetch trigger after Approve/Reject
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentional re-fetch dependency
    [refreshKey]
  )

  const requestsPromise = useEffectTs(requestsEffect, session.runtime)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await resolve={requestsPromise} errorElement={<AsyncErrorView />}>
        {(requests: readonly HttpRequest[]) => (
          <RequestsListBody
            session={session}
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
  readonly session: AuthenticatedSession
  readonly requests: readonly HttpRequest[]
  readonly onDecided: () => void
}

const RequestsListBody = ({ session, requests, onDecided }: RequestsListBodyProps): JSX.Element => {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  const decide = async (id: string, status: 'approved' | 'rejected'): Promise<void> => {
    try {
      if (status === 'approved') {
        await session.runPromise(
          Effect.flatMap(GatekeeperHttpApiClient, (c) =>
            c['access-management'].ApproveRequest({ path: { id } })
          )
        )
      } else {
        await session.runPromise(
          Effect.flatMap(GatekeeperHttpApiClient, (c) =>
            c['access-management'].DenyRequest({ path: { id } })
          )
        )
      }
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
