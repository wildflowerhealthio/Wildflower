import { HttpApiBuilder } from '@effect/platform'
import { DateTime, Effect } from 'effect'
import { AuthStore } from '../contexts/AuthStore.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import { ApprovedApps, ApprovedAppIdSchema, HttpRequests } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(AuthApi, 'auth-dashboard', (handlers) =>
  handlers
    .handle('ListApprovedApps', () =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        return store.query(ApprovedApps.queries.all$)
      })
    )
    .handle('GetApprovedApp', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        const row = store.query(ApprovedApps.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'ApprovedAppNotFound' as const,
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
    .handle('RevokeApprovedApp', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        const row = store.query(ApprovedApps.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'ApprovedAppNotFound' as const,
            id,
          })
        }
        store.commit(ApprovedApps.events.appRevoked({ id: ApprovedAppIdSchema.make(id) }))
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
