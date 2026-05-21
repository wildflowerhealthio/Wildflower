import { computed } from '@livestore/livestore'
import { ServerState } from 'local-http-server-core/livestore'

import * as TunnelConfig from '../livestore/tunnel-config.ts'

/**
 * Joined snapshot the tunnel daemon watches: tunnel intent from
 * `TunnelConfig` (`requestedRunning`, `subdomain`, `rootDomain`) plus the
 * forward-target port from `LocalHttpServerState.port`.
 *
 * Sourcing `port` from LHS state — rather than a duplicate `TunnelConfig`
 * column — means the daemon auto-reconfigures when LHS rebinds: the
 * computed query re-evaluates, `watchSnapshots` emits a new snapshot,
 * `diffIntents` produces a `StartOrReconfigure`, and `executeIntents`
 * switches the sub-scope to a fresh `startTunnel(cfg)` against the new
 * port. The tunnel never reads its own `TunnelState.currentLocalPort` —
 * that's the daemon's output, not its input.
 */
const resolvedConfig$ = computed(
  (get) => {
    const cfg = get(TunnelConfig.queries.current$)
    const server = get(ServerState.queries.current$)
    return {
      requestedRunning: cfg?.requestedRunning ?? false,
      subdomain: cfg?.subdomain ?? null,
      rootDomain: cfg?.rootDomain ?? null,
      port: server.port,
    }
  },
  { label: 'tunnelResolvedConfig', deps: 'tunnel.resolvedConfig@v1' }
)

export { resolvedConfig$ }
