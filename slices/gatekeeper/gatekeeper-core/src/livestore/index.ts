import { makeSchema, State } from '@livestore/livestore'
import * as AuthorizationCodes from './authorization-codes.ts'
import * as AuthorizationRequests from './authorization-requests.ts'
import * as Grants from './grants.ts'
import * as HttpRequests from './http-requests.ts'
import * as PinChallenges from './pin-challenges.ts'
import * as Sessions from './sessions.ts'
import * as SigningKeys from './signing-keys.ts'

const tables = {
  authorizationCodes: AuthorizationCodes.table,
  authorizationRequests: AuthorizationRequests.table,
  grants: Grants.table,
  httpRequests: HttpRequests.table,
  pinChallenges: PinChallenges.table,
  sessions: Sessions.table,
  signingKeys: SigningKeys.table,
} as const

const events = {
  ...AuthorizationCodes.events,
  ...AuthorizationRequests.events,
  ...Grants.events,
  ...HttpRequests.events,
  ...PinChallenges.events,
  ...Sessions.events,
  ...SigningKeys.events,
} as const

const materializers = State.SQLite.materializers(events, {
  ...AuthorizationCodes.materializers,
  ...AuthorizationRequests.materializers,
  ...Grants.materializers,
  ...HttpRequests.materializers,
  ...PinChallenges.materializers,
  ...Sessions.materializers,
  ...SigningKeys.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export {
  AuthorizationCodes,
  AuthorizationRequests,
  Grants,
  HttpRequests,
  PinChallenges,
  Sessions,
  SigningKeys,
  schema,
  events,
  tables,
  materializers,
}
export { GrantIdSchema } from './grants.ts'
export { HttpRequestIdSchema } from './http-requests.ts'
export { SessionIdSchema, SessionDurationSchema } from './sessions.ts'
export { SigningKey } from './signing-keys.ts'
export type { AuthorizationCodeRow } from './authorization-codes.ts'
export type { AuthorizationRequestRow } from './authorization-requests.ts'
export type { GrantRow } from './grants.ts'
export type { HttpRequestRow } from './http-requests.ts'
export type { PinChallengeRow } from './pin-challenges.ts'
export type { SessionRow, SessionDuration } from './sessions.ts'
