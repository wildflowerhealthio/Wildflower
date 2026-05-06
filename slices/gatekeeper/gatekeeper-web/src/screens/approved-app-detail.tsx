import type { Schema } from 'effect'
import type { GatekeeperAccess } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useParams } from 'react-router'
import { runAuth } from '../client.ts'

type Grant = Schema.Schema.Type<typeof GatekeeperAccess.GrantSchema>

const ApprovedAppDetailScreen = (): JSX.Element => {
  const { id = '' } = useParams<{ id: string }>()
  const [grant, setGrant] = useState<Grant | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const row = await runAuth((c) => c['gatekeeper-access'].GetGrant({ path: { id } }))
        if (!cancelled) setGrant(row)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  if (error !== null && grant === null) {
    return (
      <div className="gk-page">
        <h1 className="text-heading-4">Not Found</h1>
        <p className="gk-error text-body-3">{error}</p>
      </div>
    )
  }
  if (grant === null) {
    return (
      <div className="gk-page">
        <p className="text-body-2">Loading…</p>
      </div>
    )
  }

  return (
    <div className="gk-page">
      <h1 className="text-heading-4">{grant.clientId}</h1>
      <pre className="gk-json">{JSON.stringify(grant, null, 2)}</pre>
    </div>
  )
}

export { ApprovedAppDetailScreen }
