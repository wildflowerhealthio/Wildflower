import { HttpApiBuilder } from '@effect/platform'
import { DateTime, Effect } from 'effect'
import { GatekeeperStore } from '../contexts/gatekeeper-store.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { Grant, HttpRequest } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(GatekeeperApi, 'access-management', (handlers) =>
  handlers
    .handle('ListGrants', () =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        return store.query(Grant.queries.all$)
      })
    )
    .handle('GetGrant', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(Grant.queries.byId$(id))
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
        return store.query(HttpRequest.queries.all$)
      })
    )
    .handle('GetRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(HttpRequest.queries.byId$(id))
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
        const row = store.query(Grant.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'GrantNotFound' as const,
            id,
          })
        }
        store.commit(Grant.events.grantRevoked({ id }))
        return undefined
      })
    )
    .handle('ApproveRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(HttpRequest.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'HttpRequestNotFound' as const,
            id,
          })
        }
        store.commit(HttpRequest.events.httpRequestApproved({ id }))
        return undefined
      })
    )
    .handle('DenyRequest', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const row = store.query(HttpRequest.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({
            error: 'HttpRequestNotFound' as const,
            id,
          })
        }
        store.commit(
          HttpRequest.events.httpRequestRejected({
            id,
            respondedAt: DateTime.unsafeNow(),
          })
        )
        return undefined
      })
    )
)

export { layer }
