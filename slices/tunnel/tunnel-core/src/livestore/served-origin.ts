import { computed, type LiveQueryDef } from '@livestore/livestore'
import { ServerState } from 'local-http-server-core/livestore'

import * as TunnelState from './tunnel-state.ts'

/**
 * Public-facing origin the server is reachable at.
 *
 *  - When the tunnel is `running` and the relay has granted a full
 *    `currentSubdomain` + `currentRootDomain`, returns `https://sub.root`.
 *    An empty `currentRootDomain` (relay returned a single-label
 *    hostname — see `parseGrantedDomain` in `tunnel-expo/src/startTunnel.ts`)
 *    counts as unbound and falls through to the loopback case.
 *  - Otherwise, returns `http://${ServerState.localHostname}:${ServerState.port}`
 *    — the local HTTP server's actual bound location.
 *
 * Single source of truth for "where can clients reach this server right now."
 * Replaces ad-hoc `http://${host}:${port}` constructions across `apps-core`,
 * `wildflower-expo`, etc. The fallback reads from `LocalHttpServerState`
 * directly so the local port has exactly one source of truth.
 */
const servedOrigin$: LiveQueryDef<string> = computed(
  (get) => {
    const tunnel = get(TunnelState.queries.current$)
    const server = get(ServerState.queries.current$)
    const sub = tunnel.currentSubdomain
    const root = tunnel.currentRootDomain
    if (tunnel.running && sub !== null && sub !== '' && root !== null && root !== '') {
      return `https://${sub}.${root}`
    }
    return `http://${server.localHostname}:${server.port}`
  },
  { label: 'servedOrigin', deps: 'tunnel.servedOrigin@v1' }
)

export { servedOrigin$ }
