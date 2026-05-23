import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { Origin } from 'navigation-core'

import { TunnelAdminApi } from '../http-api-definition/index.ts'
import { TunnelConfig, TunnelState, TunnelStore } from '../livestore/index.ts'

/**
 * Combine the persistent `TunnelConfig` row and per-session `TunnelState`
 * into the wire shape, plus the live `servedOrigin` read from `Origin`.
 * The config row may be absent (fresh install, never seeded) — surface
 * defaults so clients can render before the host seeds.
 */
const snapshot = Effect.gen(function* () {
  const store = yield* TunnelStore
  const config = store.query(TunnelConfig.queries.current$)
  const state = store.query(TunnelState.queries.current$)
  const servedOrigin = yield* Origin.get
  return {
    subdomain: config?.subdomain ?? null,
    rootDomain: config?.rootDomain ?? null,
    requestedRunning: config?.requestedRunning ?? false,
    running: state.running,
    currentSubdomain: state.currentSubdomain,
    currentRootDomain: state.currentRootDomain,
    currentLocalPort: state.currentLocalPort,
    error: state.error,
    servedOrigin,
  }
})

const layer = HttpApiBuilder.group(TunnelAdminApi, 'tunnel', (handlers) =>
  handlers
    .handle('GetTunnel', () => snapshot)
    .handle('PatchTunnel', ({ payload }) =>
      Effect.gen(function* () {
        const store = yield* TunnelStore
        yield* Effect.sync(() => store.commit(TunnelConfig.events.tunnelConfigSet(payload)))
        return yield* snapshot
      })
    )
)

export { layer }
