import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { TunnelAdminApi } from '../http-api-definition/index.ts'
import { TunnelConfig, TunnelState, TunnelStore } from '../livestore/index.ts'

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value)

/**
 * Combine the persistent `TunnelConfig` row and per-session `TunnelState`
 * into the wire shape. The config row may be absent (fresh install,
 * never seeded) — surface defaults so clients can render before the
 * host seeds.
 */
const snapshot = Effect.gen(function* () {
  const store = yield* TunnelStore
  const config = store.query(TunnelConfig.queries.current$)
  const state = store.query(TunnelState.queries.current$)
  return {
    subdomain: orUndefined(config?.subdomain ?? null),
    rootDomain: orUndefined(config?.rootDomain ?? null),
    localPort: orUndefined(config?.localPort ?? null),
    requestedEnabled: config?.requestedEnabled ?? false,
    currentEnabled: state.currentEnabled,
    currentSubdomain: orUndefined(state.currentSubdomain),
    currentRootDomain: orUndefined(state.currentRootDomain),
    currentLocalPort: orUndefined(state.currentLocalPort),
    error: orUndefined(state.error),
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
