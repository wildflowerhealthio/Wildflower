import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { TunnelControl } from '../contexts/tunnel-control.ts'
import { AppsAdminApi } from '../http-api-definition/index.ts'

const layer = HttpApiBuilder.group(AppsAdminApi, 'server', (handlers) =>
  handlers
    .handle('GetServer', () =>
      Effect.gen(function* () {
        const tunnel = yield* TunnelControl
        return yield* tunnel.getState
      })
    )
    .handle('PatchServer', ({ payload }) =>
      Effect.gen(function* () {
        const tunnel = yield* TunnelControl
        const result = yield* Effect.either(tunnel.setTunnelActive(payload.tunnelActive))
        if (result._tag === 'Left') {
          return yield* Effect.fail({
            error: 'TunnelUnavailable' as const,
            reason: result.left.reason,
          })
        }
        return result.right
      })
    )
)

export { layer }
