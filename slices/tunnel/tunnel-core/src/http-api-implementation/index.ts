import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import { type LocalHttpServerStore } from 'local-http-server-core/livestore'
import { TunnelAdminApi } from '../http-api-definition/index.ts'
import { type TunnelStore } from '../livestore/index.ts'
import * as Tunnel from './tunnel.ts'

const TunnelAdminApiHandlersLive = Tunnel.layer

const TunnelAdminApiLive = HttpApiBuilder.api(TunnelAdminApi).pipe(
  Layer.provide(TunnelAdminApiHandlersLive)
)

type TunnelAdminGroupNames = 'tunnel'

const TunnelAdminApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, TunnelAdminGroupNames>,
  never,
  TunnelStore | LocalHttpServerStore
> =>
  // See gatekeeper-core's AuthApiHandlersFor: the phantom-id bridge lets a
  // Layer built against TunnelAdminApi satisfy a parent ApiId's group requirement.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  TunnelAdminApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, TunnelAdminGroupNames>,
    never,
    TunnelStore | LocalHttpServerStore
  >

export { TunnelAdminApi, TunnelAdminApiHandlersFor, TunnelAdminApiHandlersLive, TunnelAdminApiLive }
