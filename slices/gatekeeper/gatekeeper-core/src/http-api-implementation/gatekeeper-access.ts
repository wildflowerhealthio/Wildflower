import { HttpApiBuilder } from '@effect/platform'
import { DateTime, Effect } from 'effect'
import { GatekeeperStore } from '../contexts/GatekeeperStore.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { Grants, GrantIdSchema, HttpRequests } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(GatekeeperApi, 'gatekeeper-access', (handlers) =>
  handlers
    .handle('ListGrants', () =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        return store.query(Grants.queries.all$)
      })
    )
    .handle('GetGrant', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(Grants.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'GrantNotFound' as const,
            id,
          })
        }
        return row
      })
    )
    .handle('ListRequests', () =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        return store.query(HttpRequests.queries.all$)
      })
    )
    .handle('GetRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(HttpRequests.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'HttpRequestNotFound' as const,
            id,
          })
        }
        return row
      })
    )
    .handle('RevokeGrant', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(Grants.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'GrantNotFound' as const,
            id,
          })
        }
        store.commit(Grants.events.grantRevoked({ id: GrantIdSchema.make(id) }))
        return undefined
      })
    )
    .handle('ApproveRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(HttpRequests.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'HttpRequestNotFound' as const,
            id,
          })
        }
        store.commit(
          HttpRequests.events.httpRequestApproved({
            id: HttpRequests.HttpRequestIdSchema.make(id),
          })
        )
        return undefined
      })
    )
    .handle('DenyRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(HttpRequests.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'HttpRequestNotFound' as const,
            id,
          })
        }
        store.commit(
          HttpRequests.events.httpRequestRejected({
            id: HttpRequests.HttpRequestIdSchema.make(id),
            respondedAt: DateTime.unsafeNow(),
          })
        )
        return undefined
      })
    )
)

export { layer }
