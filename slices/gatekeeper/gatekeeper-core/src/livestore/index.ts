import { makeSchema, State } from '@livestore/livestore'
import * as AuthorizationCode from './authorization-code.ts'
import * as AuthorizationRequest from './authorization-request.ts'
import * as Client from './client.ts'
import * as Grant from './grant.ts'
import * as HttpRequest from './http-request.ts'
import * as SigningKey from './signing-key.ts'

const tables = {
  authorizationCode: AuthorizationCode.table,
  authorizationRequest: AuthorizationRequest.table,
  client: Client.table,
  grant: Grant.table,
  httpRequest: HttpRequest.table,
  signingKey: SigningKey.table,
} as const

const events = {
  ...AuthorizationCode.events,
  ...AuthorizationRequest.events,
  ...Client.events,
  ...Grant.events,
  ...HttpRequest.events,
  ...SigningKey.events,
} as const

const materializers = State.SQLite.materializers(events, {
  ...AuthorizationCode.materializers,
  ...AuthorizationRequest.materializers,
  ...Client.materializers,
  ...Grant.materializers,
  ...HttpRequest.materializers,
  ...SigningKey.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export {
  AuthorizationCode,
  AuthorizationRequest,
  Client,
  Grant,
  HttpRequest,
  SigningKey,
  schema,
  events,
  tables,
  materializers,
}
export { ClientKindSchema } from './client.ts'
export type { AuthorizationCodeRow } from './authorization-code.ts'
export type { AuthorizationRequestRow } from './authorization-request.ts'
export type { ClientKind, ClientRow } from './client.ts'
export type { GrantRow } from './grant.ts'
export type { HttpRequestRow } from './http-request.ts'
