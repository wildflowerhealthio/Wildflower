import { HttpApiBuilder } from '@effect/platform'
import { DateTime, Effect } from 'effect'
import { CollectorApi } from '../http-api-definition/index.ts'
import { CollectorStore, Remote } from '../livestore/index.ts'

const layer = HttpApiBuilder.group(CollectorApi, 'collector-remotes', (handlers) =>
  handlers
    .handle('ListRemotes', () =>
      Effect.gen(function* () {
        const store = yield* CollectorStore
        return store.query(Remote.queries.all$)
      })
    )
    .handle('GetRemote', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* CollectorStore
        const row = store.query(Remote.queries.byId$(id))
        if (row === undefined) {
          return yield* Effect.fail({ error: 'RemoteNotFound' as const, id })
        }
        return row
      })
    )
    .handle('CreateRemote', ({ payload }) =>
      Effect.gen(function* () {
        const store = yield* CollectorStore
        const addedAt = DateTime.unsafeNow()
        store.commit(
          Remote.events.remoteAdded({
            id: payload.id,
            name: payload.name,
            config: payload.config,
            addedAt,
          })
        )
        // `tag` mirrors `config._tag` — derived here as well as in the
        // materializer so the success response shape matches what the
        // row will contain once the commit replays. Keeps the two
        // derivations textually adjacent to their schemas.
        return {
          id: payload.id,
          name: payload.name,
          tag: payload.config._tag,
          config: payload.config,
          addedAt,
        }
      })
    )
    .handle('UpdateRemote', ({ path: { id }, payload }) =>
      Effect.gen(function* () {
        const store = yield* CollectorStore
        const existing = store.query(Remote.queries.byId$(id))
        if (existing === undefined) {
          return yield* Effect.fail({ error: 'RemoteNotFound' as const, id })
        }
        store.commit(
          Remote.events.remoteUpdated({
            id,
            name: payload.name,
            config: payload.config,
          })
        )
        return {
          id,
          name: payload.name,
          tag: payload.config._tag,
          config: payload.config,
          addedAt: existing.addedAt,
        }
      })
    )
    .handle('DeleteRemote', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* CollectorStore
        const existing = store.query(Remote.queries.byId$(id))
        if (existing === undefined) {
          return yield* Effect.fail({ error: 'RemoteNotFound' as const, id })
        }
        store.commit(Remote.events.remoteDeleted({ id }))
        return { deleted: true }
      })
    )
)

export { layer }
