import type { Schema } from 'effect'
import type { Dashboard } from 'gatekeeper-core/http-api-definition'
import { useEffect, useState, type JSX } from 'react'
import { useParams } from 'react-router'
import { runAuth } from '../client.ts'
import { clearInitial, readInitial } from '../data/initial.ts'

type ApprovedApp = Schema.Schema.Type<typeof Dashboard.ApprovedAppSchema>

const ApprovedAppDetailScreen = (): JSX.Element => {
  const { id = '' } = useParams<{ id: string }>()
  const [app, setApp] = useState<ApprovedApp | null>(() => {
    const initial = readInitial<ApprovedApp>()
    clearInitial()
    return initial
  })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const row = await runAuth((c) => c['auth-dashboard'].GetApprovedApp({ path: { id } }))
        if (!cancelled) setApp(row)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  if (error !== null && app === null) {
    return (
      <div className="gk-page">
        <h1 className="text-heading-4">Not Found</h1>
        <p className="gk-error text-body-3">{error}</p>
      </div>
    )
  }
  if (app === null) {
    return (
      <div className="gk-page">
        <p className="text-body-2">Loading…</p>
      </div>
    )
  }

  return (
    <div className="gk-page">
      <h1 className="text-heading-4">{app.label}</h1>
      <pre className="gk-json">{JSON.stringify(app, null, 2)}</pre>
    </div>
  )
}

export { ApprovedAppDetailScreen }
