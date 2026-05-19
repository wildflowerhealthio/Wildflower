import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import { apiHandlersFor } from 'shared-structures-core/http-api-implementation'

import { TunnelAdminApi } from '../http-api-definition/index.ts'
import * as Tunnel from './tunnel.ts'

const TunnelAdminApiHandlersLive = Tunnel.layer

const TunnelAdminApiLive = HttpApiBuilder.api(TunnelAdminApi).pipe(
  Layer.provide(TunnelAdminApiHandlersLive)
)

const TunnelAdminApiHandlersFor = apiHandlersFor(TunnelAdminApiHandlersLive)

export { TunnelAdminApi, TunnelAdminApiHandlersFor, TunnelAdminApiHandlersLive, TunnelAdminApiLive }
