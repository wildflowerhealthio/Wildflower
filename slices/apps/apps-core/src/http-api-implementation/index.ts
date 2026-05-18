import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import type { TunnelControl } from '../contexts/tunnel-control.ts'
import { AppsAdminApi, AppsApi } from '../http-api-definition/index.ts'
import type { AppsStore } from '../livestore/index.ts'
import * as AppsAdmin from './apps-admin.ts'
import * as Apps from './apps.ts'
import * as Server from './server.ts'

// --- Public surface ---------------------------------------------------

const AppsApiHandlersLive = Apps.layer

const AppsApiLive = HttpApiBuilder.api(AppsApi).pipe(Layer.provide(AppsApiHandlersLive))

type AppsGroupNames = 'apps'

const AppsApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, AppsGroupNames>,
  never,
  TunnelControl | AppsStore
> =>
  // See gatekeeper-core's AuthApiHandlersFor: the phantom-id bridge lets a
  // Layer built against AppsApi satisfy a parent ApiId's group requirement.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  AppsApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, AppsGroupNames>,
    never,
    TunnelControl | AppsStore
  >

// --- Admin (authed) surface ------------------------------------------

const AppsAdminApiHandlersLive = Layer.mergeAll(AppsAdmin.layer, Server.layer)

const AppsAdminApiLive = HttpApiBuilder.api(AppsAdminApi).pipe(
  Layer.provide(AppsAdminApiHandlersLive)
)

type AppsAdminGroupNames = 'apps-admin' | 'server'

const AppsAdminApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, AppsAdminGroupNames>,
  never,
  TunnelControl | AppsStore
> =>
  // Same phantom-id bridge as AppsApiHandlersFor — see that comment.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  AppsAdminApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, AppsAdminGroupNames>,
    never,
    TunnelControl | AppsStore
  >

export {
  AppsApi,
  AppsApiHandlersLive,
  AppsApiHandlersFor,
  AppsApiLive,
  AppsAdminApi,
  AppsAdminApiHandlersLive,
  AppsAdminApiHandlersFor,
  AppsAdminApiLive,
}
