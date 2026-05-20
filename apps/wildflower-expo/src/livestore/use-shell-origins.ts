import type { Store } from '@livestore/livestore'
import type { ReactApi } from '@livestore/react'
import { ServerState } from 'local-http-server-core/livestore'
import { TunnelState } from 'tunnel-core/livestore'
import { LOCAL_ORIGIN } from '../daemons/http-server.ts'
import { useWildflowerStore } from './livestore-store.ts'
import type { schema } from './schema.ts'

type ShellOrigins = {
  readonly store: Store<typeof schema, object> & ReactApi
  readonly running: boolean
  readonly localOrigin: string
  readonly publicOrigin: string | null
}

/**
 * Subscribes to the wildflower store, the LHS `ServerState` and the
 * tunnel `TunnelState`, and derives the origins the shell hands to the
 * WebView:
 *
 *  - `localOrigin` is the LHS-reported origin, falling back to the
 *    compile-time `LOCAL_ORIGIN` while the daemon is starting.
 *  - `publicOrigin` is the live tunnel hostname when the tunnel has
 *    been granted a `currentSubdomain`/`currentRootDomain`, else `null`.
 *
 * `store` is returned so callers that need to commit events (e.g.
 * `commitAndAwaitTunnel`) don't have to call `useWildflowerStore`
 * twice.
 */
function useShellOrigins(): ShellOrigins {
  const store = useWildflowerStore()
  const serverState = store.useQuery(ServerState.queries.current$)
  const tunnelState = store.useQuery(TunnelState.queries.current$)
  const publicOrigin =
    tunnelState.currentSubdomain !== null && tunnelState.currentRootDomain !== null
      ? `https://${tunnelState.currentSubdomain}.${tunnelState.currentRootDomain}`
      : null
  return {
    store,
    running: serverState.running,
    localOrigin: serverState.localOrigin ?? LOCAL_ORIGIN,
    publicOrigin,
  }
}

export { useShellOrigins }
