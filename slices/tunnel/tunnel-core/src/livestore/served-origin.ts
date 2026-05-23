import { computed, type LiveQueryDef } from '@livestore/livestore'
import { ServerState } from 'local-http-server-core/livestore'

import * as TunnelState from './tunnel-state.ts'

/**
 * Tagged view of where the server is reachable: `tunnel` when the relay
 * is up and has granted a full `currentSubdomain` + `currentRootDomain`,
 * `loopback` otherwise. The tag lets consumers branch on liveness
 * without string-matching the URL scheme.
 */
type ServedOrigin =
  | { readonly kind: 'tunnel'; readonly origin: string }
  | { readonly kind: 'loopback'; readonly origin: string }

const isBound = (value: string | null): value is string => value !== null && value !== ''

const servedOrigin$: LiveQueryDef<ServedOrigin> = computed(
  (get): ServedOrigin => {
    const tunnel = get(TunnelState.queries.current$)
    const server = get(ServerState.queries.current$)
    if (tunnel.running && isBound(tunnel.currentSubdomain) && isBound(tunnel.currentRootDomain)) {
      return {
        kind: 'tunnel',
        origin: `https://${tunnel.currentSubdomain}.${tunnel.currentRootDomain}`,
      }
    }
    return { kind: 'loopback', origin: `http://${server.localHostname}:${server.port}` }
  },
  { label: 'servedOrigin', deps: 'tunnel.servedOrigin@v1' }
)

export { servedOrigin$ }
export type { ServedOrigin }
