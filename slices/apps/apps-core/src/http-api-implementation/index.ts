import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import type { GatekeeperStore } from 'gatekeeper-core/contexts'
import { RequireAuthMiddlewareLive } from 'gatekeeper-core/http-api-implementation'
import type { Origin } from 'navigation-core'
import type { AppsStore } from '../contexts/apps-store.ts'
import type { TunnelControl } from '../contexts/tunnel-control.ts'
import { AppsApi } from '../http-api-definition/index.ts'
import * as Apps from './apps.ts'
import * as Server from './server.ts'

const AppsApiHandlersLive = Layer.mergeAll(Server.layer, Apps.layer).pipe(
  Layer.provide(RequireAuthMiddlewareLive)
)

const AppsApiLive = HttpApiBuilder.api(AppsApi).pipe(Layer.provide(AppsApiHandlersLive))

type AppsGroupNames = 'server' | 'apps'

const AppsApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, AppsGroupNames>,
  never,
  TunnelControl | AppsStore | GatekeeperStore | Origin
> =>
  // The phantom-id bridge: `ApiGroup<ApiId, Name>` is a structural marker
  // with no runtime presence (HttpApiBuilder.group only registers routes on
  // the shared Router; nothing reads `apiId`), so a Layer built against
  // AppsApi is sound to satisfy the same group requirement under any
  // consumer's parent ApiId. This cast is the one place that bridge lives.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  AppsApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, AppsGroupNames>,
    never,
    TunnelControl | AppsStore | GatekeeperStore | Origin
  >

export { AppsApi, AppsApiHandlersLive, AppsApiHandlersFor, AppsApiLive }
