import { computed, type LiveQueryDef } from '@livestore/livestore'
import { ServerState } from 'local-http-server-core/livestore'

import * as TunnelConfig from './tunnel-config.ts'
import * as TunnelState from './tunnel-state.ts'

/**
 * Tagged view of where the server is reachable:
 *
 *  - `tunnel` — the relay is up and has granted a bound `currentSubdomain` +
 *    `currentRootDomain`; clients should hit the public URL.
 *  - `tunnelUnavailable` — the user has requested the tunnel be running, but
 *    it isn't bound (still starting up, relay refused, or single-label
 *    hostname). `origin` is the loopback fallback; `error` carries
 *    `TunnelState.error` for callers that want to surface why.
 *  - `loopback` — the user hasn't requested the tunnel; the server is only
 *    reachable at loopback.
 *
 * The tag lets consumers branch on liveness without string-matching the URL
 * scheme, and lets the launch flow distinguish "loopback because not needed"
 * from "loopback because the tunnel couldn't be brought up."
 */
type ServedOrigin =
  | { readonly kind: 'tunnel'; readonly origin: string }
  | { readonly kind: 'tunnelUnavailable'; readonly origin: string; readonly error: string | null }
  | { readonly kind: 'loopback'; readonly origin: string }

const isPresent = (value: string | null): value is string => value !== null && value !== ''

const servedOrigin$: LiveQueryDef<ServedOrigin> = computed(
  (get): ServedOrigin => {
    const tunnel = get(TunnelState.queries.current$)
    const config = get(TunnelConfig.queries.current$)
    const server = get(ServerState.queries.current$)
    const loopback = `http://${server.localHostname}:${server.port}`
    if (
      tunnel.running &&
      isPresent(tunnel.currentSubdomain) &&
      isPresent(tunnel.currentRootDomain)
    ) {
      return {
        kind: 'tunnel',
        origin: `https://${tunnel.currentSubdomain}.${tunnel.currentRootDomain}`,
      }
    }
    if (config?.requestedRunning === true) {
      return { kind: 'tunnelUnavailable', origin: loopback, error: tunnel.error }
    }
    return { kind: 'loopback', origin: loopback }
  },
  { label: 'servedOrigin', deps: 'tunnel.servedOrigin@v1' }
)

export { servedOrigin$ }
export type { ServedOrigin }
