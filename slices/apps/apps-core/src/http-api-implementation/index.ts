import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import type { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { apiHandlersFor } from 'shared-structures-core/http-api-implementation'

import { AppsAdminApi, AppsApi } from '../http-api-definition/index.ts'
import type { AppsStore } from '../livestore/index.ts'
import * as AppsAdmin from './apps-admin.ts'
import * as Apps from './apps.ts'

// --- Public surface ---------------------------------------------------

const AppsApiHandlersLive = Apps.layer

const AppsApiLive = HttpApiBuilder.api(AppsApi).pipe(Layer.provide(AppsApiHandlersLive))

const AppsApiHandlersFor = apiHandlersFor<
  'AppsApi',
  ['apps'],
  never,
  AppsStore | LocalHttpServerStore
>(AppsApiHandlersLive)

// --- Admin (authed) surface ------------------------------------------

const AppsAdminApiHandlersLive = AppsAdmin.layer

const AppsAdminApiLive = HttpApiBuilder.api(AppsAdminApi).pipe(
  Layer.provide(AppsAdminApiHandlersLive)
)

const AppsAdminApiHandlersFor = apiHandlersFor<'AppsAdminApi', ['apps-admin'], never, AppsStore>(
  AppsAdminApiHandlersLive
)

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
