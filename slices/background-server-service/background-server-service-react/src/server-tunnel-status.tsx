import { useQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import type { JSX } from 'react'
import { ErrorBanner, PageLoading } from 'react-tundraish'
import { TunnelStatusHero, tunnelStateQueryOptions } from 'tunnel-react'

import type { RouterContext, RunAuthed } from './router-context.ts'

// Annotated `select` so the result stays typed when the slice's router isn't
// registered (standalone build).
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })

/**
 * The tunnel's status and public host, read through `tunnel-react`'s own
 * `GET /tunnel` query and drawn with its `TunnelStatusHero`, read-only.
 *
 * @remarks
 * Mounted only while the server runs: the tunnel lives inside the server, so
 * there is nothing to ask while it is stopped. The shared cache can hold a
 * previous run's tunnel (the app warms it at boot, and a restart starts a new
 * tunnel), so every mount refetches (`refetchOnMount: 'always'`) and shows
 * loading until that fetch settles (`isFetchedAfterMount`) rather than the
 * cached data. Later background refetches, such as on window focus, keep
 * showing the data they replace. The Run-tunnel switch stays on the Tunnel
 * settings page, which this links to.
 */
const ServerTunnelStatus = (): JSX.Element => {
  const tunnelStateQuery = useQuery({
    ...tunnelStateQueryOptions(useRunAuthed()),
    refetchOnMount: 'always',
  })
  if (tunnelStateQuery.isPending || !tunnelStateQuery.isFetchedAfterMount)
    return <PageLoading message="Loading the tunnel…" />
  if (tunnelStateQuery.isError) return <ErrorBanner error={tunnelStateQuery.error} />
  return (
    <>
      <TunnelStatusHero state={tunnelStateQuery.data} disabled />
      <p className="text-body-3">
        Turn the tunnel on or off and set its public host in{' '}
        <Link to="/settings/tunnel">Tunnel settings</Link>.
      </p>
    </>
  )
}

export { ServerTunnelStatus }
