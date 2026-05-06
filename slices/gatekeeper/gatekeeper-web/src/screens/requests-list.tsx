import type { Schema } from 'effect'
import type { Dashboard } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useNavigate } from 'react-router'
import { ItemList } from 'react-tundraish'
import { runAuth } from '../client.ts'
import { clearInitial, readInitial } from '../data/initial.ts'

type HttpRequest = Schema.Schema.Type<typeof Dashboard.HttpRequestSchema>

type InitialState = { readonly requests: readonly HttpRequest[] }

const formatDate = (value: { epochMillis: number } | Date | string): string => {
  const ms =
    typeof value === 'string'
      ? Date.parse(value)
      : value instanceof Date
        ? value.getTime()
        : value.epochMillis
  return new Date(ms).toLocaleString()
}

const RequestsListScreen = (): JSX.Element => {
  const navigate = useNavigate()
  const [requests, setRequests] = useState<readonly HttpRequest[]>(() => {
    const initial = readInitial<InitialState>()
    clearInitial()
    return initial?.requests ?? []
  })
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const list = await runAuth((c) => c['auth-dashboard'].ListRequests())
      setRequests(list)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const decide = async (id: string, status: 'approved' | 'rejected'): Promise<void> => {
    try {
      await runAuth((c) => c['auth-dashboard'].DecideRequest({ path: { id }, payload: { status } }))
      await refresh()
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
      r.origin !== '' ? `${r.origin} · ${formatDate(r.requestedAt)}` : formatDate(r.requestedAt),
    onClick: () => {
      void navigate(`/requests/${encodeURIComponent(r.id)}`)
    },
    actions:
      r.status === 'pending' ? (
        <div className="gk-row-actions">
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
    <div className="gk-page">
      {error !== null ? <p className="gk-error text-body-3">{error}</p> : null}
      <ItemList title="In-Flight" items={pending.map((r) => toItem(r))} />
      <ItemList title="Approved" items={approved.map((r) => toItem(r))} />
      <ItemList title="Rejected" items={rejected.map((r) => toItem(r))} />
    </div>
  )
}

export { RequestsListScreen }
