/* oxlint-disable react/only-export-components -- file-based route file exports `Route` alongside the component */

import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { Suspense, useMemo, useState, type JSX } from 'react'
import { Awaited, PageLoading } from 'react-tundraish'
import { TunnelAdminHttpApiClient } from 'tunnel-core/clients'

import { useTunnelAdminEffect } from '../../../use-tunnel-admin-effect.ts'
import { TunnelScreenBody } from './tunnel-screen-body.tsx'

function TunnelScreen(): JSX.Element {
  const [refreshKey, setRefreshKey] = useState(0)

  const tunnelEffect = useMemo(
    () => Effect.flatMap(TunnelAdminHttpApiClient, (c) => c.tunnel.GetTunnel()),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the intentional re-fetch trigger
    [refreshKey]
  )

  const tunnelPromise = useTunnelAdminEffect(tunnelEffect)

  return (
    <Suspense fallback={<PageLoading message="Loading tunnel…" />}>
      <Awaited promise={tunnelPromise} resetKey={refreshKey} errorTitle="Tunnel">
        {(state) => (
          <TunnelScreenBody
            state={state}
            onChanged={() => {
              setRefreshKey((n) => n + 1)
            }}
          />
        )}
      </Awaited>
    </Suspense>
  )
}

export const Route = createFileRoute('/settings/tunnel/')({
  component: TunnelScreen,
})
