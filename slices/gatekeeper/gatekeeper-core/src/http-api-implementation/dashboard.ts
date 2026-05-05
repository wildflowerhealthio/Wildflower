import { HttpApiBuilder } from '@effect/platform'
import { DateTime, Effect } from 'effect'
import { AuthStore } from '../contexts/AuthStore.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import { Clients, ClientIdSchema, HttpRequests } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(AuthApi, 'auth-dashboard', (handlers) =>
  handlers
    .handle('ListClients', () =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        return store.query(Clients.queries.all$)
      })
    )
    .handle('GetClient', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        const row = store.query(Clients.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'ClientNotFound' as const,
            id,
          })
        }
        return row
      })
    )
    .handle('ListRequests', () =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        return store.query(HttpRequests.queries.all$)
      })
    )
    .handle('GetRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore
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
    .handle('RevokeClient', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        const row = store.query(Clients.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'ClientNotFound' as const,
            id,
          })
        }
        store.commit(Clients.events.clientRevoked({ id: ClientIdSchema.make(id) }))
        return undefined
      })
    )
    .handle('DecideRequest', ({ path: { id }, payload }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        const row = store.query(HttpRequests.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'HttpRequestNotFound' as const,
            id,
          })
        }
        const requestId = HttpRequests.HttpRequestIdSchema.make(id)
        if (payload.status === 'approved') {
          store.commit(HttpRequests.events.httpRequestApproved({ id: requestId }))
        } else {
          store.commit(
            HttpRequests.events.httpRequestRejected({
              id: requestId,
              respondedAt: DateTime.unsafeNow(),
            })
          )
        }
        return undefined
      })
    )
)

export { layer }
