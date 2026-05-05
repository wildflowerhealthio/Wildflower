import { makeSchema, State } from '@livestore/livestore'
import * as AuthCodes from './auth-codes.ts'
import * as Clients from './clients.ts'
import * as HttpRequests from './http-requests.ts'
import * as JsonWebKeys from './json-web-keys.ts'
import * as PinAuths from './pin-auths.ts'

const tables = {
  authCodes: AuthCodes.table,
  clients: Clients.table,
  httpRequests: HttpRequests.table,
  jsonWebKeys: JsonWebKeys.table,
  pinAuths: PinAuths.table,
} as const

const events = {
  ...AuthCodes.events,
  ...Clients.events,
  ...HttpRequests.events,
  ...JsonWebKeys.events,
  ...PinAuths.events,
} as const

const materializers = State.SQLite.materializers(events, {
  ...AuthCodes.materializers,
  ...Clients.materializers,
  ...HttpRequests.materializers,
  ...JsonWebKeys.materializers,
  ...PinAuths.materializers,
})

// AuthCodes => RequestTokens
// Clients => Consumer
// HttpRequests => HttpRequestEvents
// JsonWebKeys => JsonWebKeys (unchanged)
//
const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export {
  AuthCodes,
  Clients,
  HttpRequests,
  JsonWebKeys,
  PinAuths,
  schema,
  events,
  tables,
  materializers,
}
export { ClientIdSchema } from './clients.ts'
export { HttpRequestIdSchema } from './http-requests.ts'
export { RsaJwk } from './json-web-keys.ts'
export { PinAuthDurationSchema } from './pin-auths.ts'
export type { AuthCodeRow } from './auth-codes.ts'
export type { ClientRow } from './clients.ts'
export type { HttpRequestRow } from './http-requests.ts'
export type { PinAuthRow, PinAuthDuration } from './pin-auths.ts'
