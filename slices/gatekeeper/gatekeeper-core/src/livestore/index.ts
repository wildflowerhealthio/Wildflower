import { makeSchema, State } from '@livestore/livestore'
import * as AuthorizationCodes from './authorization-codes.ts'
import * as AuthorizationRequests from './authorization-requests.ts'
import * as Clients from './clients.ts'
import * as Grants from './grants.ts'
import * as HttpRequests from './http-requests.ts'
import * as SigningKeys from './signing-keys.ts'

const tables = {
  authorizationCodes: AuthorizationCodes.table,
  authorizationRequests: AuthorizationRequests.table,
  clients: Clients.table,
  grants: Grants.table,
  httpRequests: HttpRequests.table,
  signingKeys: SigningKeys.table,
} as const

const events = {
  ...AuthorizationCodes.events,
  ...AuthorizationRequests.events,
  ...Clients.events,
  ...Grants.events,
  ...HttpRequests.events,
  ...SigningKeys.events,
} as const

const materializers = State.SQLite.materializers(events, {
  ...AuthorizationCodes.materializers,
  ...AuthorizationRequests.materializers,
  ...Clients.materializers,
  ...Grants.materializers,
  ...HttpRequests.materializers,
  ...SigningKeys.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export {
  AuthorizationCodes,
  AuthorizationRequests,
  Clients,
  Grants,
  HttpRequests,
  SigningKeys,
  schema,
  events,
  tables,
  materializers,
}
export { SigningKey } from './signing-keys.ts'
export { ClientKindSchema } from './clients.ts'
export type { AuthorizationCodeRow } from './authorization-codes.ts'
export type { AuthorizationRequestRow } from './authorization-requests.ts'
export type { ClientKind, ClientRow } from './clients.ts'
export type { GrantRow } from './grants.ts'
export type { HttpRequestRow } from './http-requests.ts'
