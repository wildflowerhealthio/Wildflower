import { makeSchema, State } from '@livestore/livestore'
import * as ApprovedApps from './approved-apps.ts'
import * as HttpRequests from './http-requests.ts'
import * as JsonWebKeys from './json-web-keys.ts'

const tables = {
  approvedApps: ApprovedApps.table,
  httpRequests: HttpRequests.table,
  jsonWebKeys: JsonWebKeys.table,
} as const

const events = {
  ...ApprovedApps.events,
  ...HttpRequests.events,
  ...JsonWebKeys.events,
} as const

const materializers = State.SQLite.materializers(events, {
  ...ApprovedApps.materializers,
  ...HttpRequests.materializers,
  ...JsonWebKeys.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export { ApprovedApps, HttpRequests, JsonWebKeys, schema, events, tables, materializers }
export { ApprovedAppIdSchema } from './approved-apps.ts'
export { HttpRequestIdSchema } from './http-requests.ts'
export { RsaJwk } from './json-web-keys.ts'
export type { ApprovedAppRow } from './approved-apps.ts'
export type { HttpRequestRow } from './http-requests.ts'
