import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import type { Origin } from 'navigation-core'
import { apiHandlersFor } from 'shared-structures-core/http-api-implementation'

import { TunnelAdminApi } from '../http-api-definition/index.ts'
import type { TunnelStore } from '../livestore/index.ts'
import * as Tunnel from './tunnel.ts'

const TunnelAdminApiHandlersLive = Tunnel.layer

const TunnelAdminApiLive = HttpApiBuilder.api(TunnelAdminApi).pipe(
  Layer.provide(TunnelAdminApiHandlersLive)
)

const TunnelAdminApiHandlersFor = apiHandlersFor<
  'TunnelAdminApi',
  ['tunnel'],
  never,
  TunnelStore | Origin
>(TunnelAdminApiHandlersLive)

export { TunnelAdminApi, TunnelAdminApiHandlersFor, TunnelAdminApiHandlersLive, TunnelAdminApiLive }
