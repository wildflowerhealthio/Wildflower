import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { TunnelAdminApi } from '../http-api-definition/index.ts'
import { TunnelState, TunnelStore } from '../livestore/index.ts'

/** Strip nulls so the wire shape uses optional/absent keys. */
const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value)

/**
 * Combine the per-session tunnel + server documents into the wire
 * shape. Either document may be at its default (just-booted, nothing
 * written yet), so optional fields decay to `undefined` naturally.
 */
const snapshot = Effect.gen(function* () {
  const tunnelStore = yield* TunnelStore
  const serverStore = yield* LocalHttpServerStore
  const tunnel = tunnelStore.query(TunnelState.queries.current$)
  const server = serverStore.query(ServerState.queries.current$)
  return {
    requestedPublicOrigin: orUndefined(tunnel.requestedPublicOrigin),
    currentPublicOrigin: orUndefined(tunnel.currentPublicOrigin),
    localOrigin: orUndefined(server.localOrigin),
    port: orUndefined(server.port),
    running: server.running,
  }
})

const layer = HttpApiBuilder.group(TunnelAdminApi, 'tunnel', (handlers) =>
  handlers
    .handle('GetTunnel', () => snapshot)
    .handle('PatchTunnel', ({ payload }) =>
      Effect.gen(function* () {
        const tunnelStore = yield* TunnelStore
        yield* Effect.sync(() =>
          tunnelStore.commit(
            TunnelState.events.tunnelStateSet({
              requestedPublicOrigin: payload.requestedPublicOrigin,
            })
          )
        )
        return yield* snapshot
      })
    )
)

export { layer }
