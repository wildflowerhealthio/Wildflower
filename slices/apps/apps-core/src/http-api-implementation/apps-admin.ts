import { HttpApiBuilder } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { Effect } from 'effect'
import { AppsStore } from '../contexts/apps-store.ts'
import { AppsAdminApi } from '../http-api-definition/index.ts'
import { awaitRow } from '../internal/await-row.ts'
import { AppSelection } from '../livestore/index.ts'
import { findBundled } from '../registry/index.ts'

const layer = HttpApiBuilder.group(AppsAdminApi, 'apps-admin', (handlers) =>
  handlers
    .handle('CreateCustomApp', ({ payload }) =>
      Effect.gen(function* () {
        const store = yield* AppsStore
        const id = `custom-${nanoid()}`
        store.commit(
          AppSelection.events.customAppAdded({
            id,
            name: payload.name,
            url: payload.url,
            requiresTunnel: payload.requiresTunnel,
          })
        )
        return {
          id,
          name: payload.name,
          subtitle: payload.url,
          requiresTunnel: payload.requiresTunnel,
          kind: 'custom' as const,
          enabled: true,
        }
      })
    )
    .handle('UpdateApp', ({ path, payload }) =>
      Effect.gen(function* () {
        const store = yield* AppsStore
        const bundled = findBundled(path.id)
        const existing = store.query(AppSelection.queries.byId$(path.id))

        if (bundled !== undefined) {
          if (payload.name !== undefined || payload.url !== undefined) {
            return yield* Effect.fail({
              error: 'BundledAppImmutable' as const,
              id: path.id,
            })
          }
          const enabled = payload.enabled ?? existing?.enabled ?? true
          store.commit(
            AppSelection.events.appEnabledChanged({
              id: path.id,
              kind: bundled.kind,
              enabled,
            })
          )
          return {
            id: path.id,
            name: bundled.name,
            subtitle: bundled.subtitle,
            requiresTunnel: bundled.requiresTunnel,
            kind: bundled.kind,
            enabled,
          }
        }

        if (existing === undefined || existing.kind !== 'custom') {
          return yield* Effect.fail({ error: 'AppNotFound' as const, id: path.id })
        }

        const expectedName = payload.name ?? existing.customName
        const expectedUrl = payload.url ?? existing.customUrl
        const expectedRequiresTunnel = payload.requiresTunnel ?? existing.customRequiresTunnel
        const expectedEnabled = payload.enabled ?? existing.enabled

        if (
          payload.name !== undefined ||
          payload.url !== undefined ||
          payload.requiresTunnel !== undefined
        ) {
          store.commit(
            AppSelection.events.customAppUpdated({
              id: path.id,
              name: payload.name,
              url: payload.url,
              requiresTunnel: payload.requiresTunnel,
            })
          )
        }

        if (payload.enabled !== undefined) {
          store.commit(
            AppSelection.events.appEnabledChanged({
              id: path.id,
              kind: 'custom',
              enabled: payload.enabled,
            })
          )
        }

        // Wait for the materializer to reflect the committed events
        // before computing the response shape, so the response matches
        // what subsequent reads will see (rather than racing with
        // batched materialisation).
        const updated = yield* awaitRow(
          AppSelection.queries.byId$(path.id),
          (row) =>
            row.customName === expectedName &&
            row.customUrl === expectedUrl &&
            row.customRequiresTunnel === expectedRequiresTunnel &&
            row.enabled === expectedEnabled,
          `appSelection/${path.id}`
        ).pipe(
          // If the materialiser never converges (e.g. an in-flight
          // delete races the update), fall back to the optimistic
          // shape so the client still gets a response.
          Effect.catchTag('MaterialisationTimedOut', () =>
            Effect.succeed({
              ...existing,
              customName: expectedName,
              customUrl: expectedUrl,
              customRequiresTunnel: expectedRequiresTunnel,
              enabled: expectedEnabled,
            })
          )
        )

        return {
          id: path.id,
          name: updated.customName ?? 'Custom App',
          subtitle: updated.customUrl ?? '',
          requiresTunnel: updated.customRequiresTunnel ?? false,
          kind: 'custom' as const,
          enabled: updated.enabled,
        }
      })
    )
    .handle('DeleteApp', ({ path }) =>
      Effect.gen(function* () {
        const store = yield* AppsStore
        const bundled = findBundled(path.id)
        if (bundled !== undefined) {
          return yield* Effect.fail({
            error: 'BundledAppImmutable' as const,
            id: path.id,
          })
        }
        const existing = store.query(AppSelection.queries.byId$(path.id))
        if (existing === undefined) {
          return yield* Effect.fail({ error: 'AppNotFound' as const, id: path.id })
        }
        store.commit(AppSelection.events.customAppRemoved({ id: path.id }))
        return { deleted: true }
      })
    )
)

export { layer }
