import type { Schema } from 'effect'
import type { GatekeeperAccess } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useParams } from 'react-router'
import { StatusBadge, type StatusTone } from 'react-tundraish'
import { runAuth } from '../client.ts'

type HttpRequest = Schema.Schema.Type<typeof GatekeeperAccess.HttpRequestSchema>

const formatDate = (value: { epochMillis: number } | Date | string): string => {
  const ms =
    typeof value === 'string'
      ? Date.parse(value)
      : value instanceof Date
        ? value.getTime()
        : value.epochMillis
  return new Date(ms).toLocaleString()
}

const statusTone = (status: string): StatusTone => {
  if (status === 'approved') return 'success'
  if (status === 'rejected') return 'danger'
  if (status === 'pending') return 'warning'
  return 'neutral'
}

const RequestDetailScreen = (): JSX.Element => {
  const { id = '' } = useParams<{ id: string }>()
  const [request, setRequest] = useState<HttpRequest | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const row = await runAuth((c) => c['gatekeeper-access'].GetRequest({ path: { id } }))
      setRequest(row)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const decide = async (status: 'approved' | 'rejected'): Promise<void> => {
    try {
      if (status === 'approved') {
        await runAuth((c) => c['gatekeeper-access'].ApproveRequest({ path: { id } }))
      } else {
        await runAuth((c) => c['gatekeeper-access'].DenyRequest({ path: { id } }))
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (error !== null && request === null) {
    return (
      <div className="gk-page">
        <h1 className="text-heading-4">Not Found</h1>
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

  return (
    <div className="gk-page">
      <div className="gk-section">
        <h2 className="text-label-3">{request.method}</h2>
        <h1 className="text-heading-4">{request.url}</h1>
      </div>

      <StatusBadge tone={statusTone(request.status)}>{request.status.toUpperCase()}</StatusBadge>

      <div className="gk-section">
        <strong className="text-label-3">Request</strong>
        <span className="text-body-3">Received: {formatDate(request.requestedAt)}</span>
        {request.origin !== '' ? (
          <span className="text-body-3">Origin: {request.origin}</span>
        ) : null}
        {request.userAgent !== '' ? (
          <span className="text-body-3">User-Agent: {request.userAgent}</span>
        ) : null}
      </div>

      {request.respondedAt !== null ? (
        <div className="gk-section">
          <strong className="text-label-3">Response</strong>
          <span className="text-body-3">Responded: {formatDate(request.respondedAt)}</span>
          {request.statusCode !== null ? (
            <span className="text-body-3">Status: {request.statusCode}</span>
          ) : null}
        </div>
      ) : null}

      {request.status === 'pending' ? (
        <div className="gk-buttons">
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

      {error !== null ? <p className="gk-error text-body-3">{error}</p> : null}
    </div>
  )
}

export { RequestDetailScreen }
