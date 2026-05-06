import { HttpApiBuilder } from '@effect/platform'
import { Effect, pipe } from 'effect'
import { GatekeeperApi } from '../../http-api-definition/index.ts'
import { httpApiGroup } from '../../http-api-definition/oauth.ts'
import {
  getAuthorizationRequestForStatus,
  renderAuthorizationStatus,
} from './authorization-status.ts'
import { handleAuthorize } from './authorize.ts'
import { handleDeviceAuthorization } from './device-authorization.ts'
import { sha256Hex } from './shared.ts'
import { handleTokenExchange } from './token-exchange/index.ts'

const layer = HttpApiBuilder.group(GatekeeperApi, 'oauth', (handlers) =>
  handlers
    .handleRaw('Authorize', ({ urlParams }) => handleAuthorize(urlParams))
    .handle('AuthorizationStatus', ({ path: { id } }) =>
      pipe(getAuthorizationRequestForStatus(id), Effect.flatMap(renderAuthorizationStatus))
    )
    .handle('TokenExchange', ({ payload }) => handleTokenExchange(payload))
    .handle('DeviceAuthorization', ({ payload }) => handleDeviceAuthorization(payload))
)

export { httpApiGroup, layer, sha256Hex }
