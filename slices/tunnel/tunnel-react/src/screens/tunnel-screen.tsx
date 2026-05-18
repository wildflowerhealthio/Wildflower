import { Effect, type Schema } from 'effect'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Await } from 'react-router'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import type { Tunnel } from 'tunnel-core/http-api-definition'

import { TunnelToggle } from '../components/tunnel-toggle.tsx'
import { useTunnelAdminEffect } from '../use-tunnel-effect.ts'

type TunnelState = Schema.Schema.Type<typeof Tunnel.TunnelStateSchema>

/**
 * Tunnel-state screen. Reads `GET /tunnel` via the slice's admin
 * client, displays the public + local origins, and renders a toggle
 * button that fires `PATCH /tunnel`. `refreshKey` re-issues the GET
 * after a successful toggle so other readers (the badge in the apps
 * home, etc.) pick up the new state too.
 */
const TunnelScreen = (): JSX.Element => {
  const [refreshKey, setRefreshKey] = useState(0)

  const tunnelEffect = useMemo(
    () => Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )
  const tunnelPromise = useTunnelAdminEffect(tunnelEffect)

  return (
    <Suspense fallback={<p className="text-body-2">Loading tunnel…</p>}>
      <Await resolve={tunnelPromise}>
        {(state: TunnelState) => (
          <TunnelBody
            state={state}
            onChanged={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Await>
    </Suspense>
  )
}

interface TunnelBodyProps {
  readonly state: TunnelState
  readonly onChanged: () => void
}

const deriveStatus = (state: TunnelState): string => {
  if (state.currentEnabled) return 'Active'
  if (state.requestedEnabled) return 'Requested'
  return 'Inactive'
}

const composePublicOrigin = (state: TunnelState): string | null => {
  if (state.currentSubdomain !== undefined && state.currentRootDomain !== undefined) {
    return `https://${state.currentSubdomain}.${state.currentRootDomain}`
  }
  if (state.subdomain !== undefined && state.rootDomain !== undefined) {
    return `https://${state.subdomain}.${state.rootDomain}`
  }
  return null
}

const TunnelBody = ({ state, onChanged }: TunnelBodyProps): JSX.Element => {
  const status = deriveStatus(state)
  const publicOrigin = composePublicOrigin(state)
  return (
    <section>
      <h1 className={cn('text-heading-4')}>Tunnel</h1>
      <dl>
        <dt className="text-label-3">Status</dt>
        <dd className="text-body-2">{status}</dd>
        <dt className="text-label-3">Public origin</dt>
        <dd className="text-body-3">{publicOrigin ?? '—'}</dd>
        <dt className="text-label-3">Local port</dt>
        <dd className="text-body-3">{state.localPort ?? '—'}</dd>
      </dl>
      {state.error !== undefined ? (
        <p className="text-body-3" role="alert">
          {state.error}
        </p>
      ) : null}
      <TunnelToggle state={state} onChanged={onChanged} />
    </section>
  )
}

export { TunnelScreen }
