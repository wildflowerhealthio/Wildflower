import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { Effect } from 'effect'
import { AppsStore } from '../contexts/apps-store.ts'
import { TunnelControl } from '../contexts/tunnel-control.ts'
import { AppsApi } from '../http-api-definition/index.ts'
import { AppSelection } from '../livestore/index.ts'
import type { AppId, AppKind } from '../registry/app-item.ts'
import { BUNDLED_APPS, FHIR_SHARING_ID, findBundled, makeAppId } from '../registry/index.ts'

type AppEntry = {
  id: AppId
  name: string
  subtitle: string
  requiresTunnel: boolean
  kind: AppKind
  enabled: boolean
}

const buildEntries = (selection: readonly AppSelection.AppSelectionRow[]): readonly AppEntry[] => {
  const byId = new Map(selection.map((row) => [row.id, row]))

  const bundled: AppEntry[] = BUNDLED_APPS.map((app) => {
    const row = byId.get(app.id)
    return {
      id: app.id,
      name: app.name,
      subtitle: app.subtitle,
      requiresTunnel: app.requiresTunnel,
      kind: app.kind,
      enabled: row?.enabled ?? true,
    }
  })

  const custom: AppEntry[] = selection
    .filter((row) => row.kind === 'custom')
    .map((row) => ({
      id: makeAppId(row.id),
      name: row.customName ?? 'Custom App',
      subtitle: row.customUrl ?? '',
      requiresTunnel: row.customRequiresTunnel ?? false,
      kind: 'custom' as const,
      enabled: row.enabled,
    }))

  return [...bundled, ...custom]
}

const layer = HttpApiBuilder.group(AppsApi, 'apps', (handlers) =>
  handlers
    .handle('ListApps', () =>
      Effect.gen(function* () {
        const store = yield* AppsStore
        const rows = store.query(AppSelection.queries.all$)
        return buildEntries(rows)
      })
    )
    .handle('CreateCustomApp', ({ payload }) =>
      Effect.gen(function* () {
        const store = yield* AppsStore
        const id = makeAppId(`custom-${nanoid()}`)
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
              id: makeAppId(path.id),
              kind: bundled.kind,
              enabled,
            })
          )
          return {
            id: makeAppId(path.id),
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

        if (
          payload.name !== undefined ||
          payload.url !== undefined ||
          payload.requiresTunnel !== undefined
        ) {
          store.commit(
            AppSelection.events.customAppUpdated({
              id: makeAppId(path.id),
              name: payload.name,
              url: payload.url,
              requiresTunnel: payload.requiresTunnel,
            })
          )
        }

        if (payload.enabled !== undefined) {
          store.commit(
            AppSelection.events.appEnabledChanged({
              id: makeAppId(path.id),
              kind: 'custom',
              enabled: payload.enabled,
            })
          )
        }

        const updated = store.query(AppSelection.queries.byId$(path.id))
        return {
          id: makeAppId(path.id),
          name: updated?.customName ?? existing.customName ?? 'Custom App',
          subtitle: updated?.customUrl ?? existing.customUrl ?? '',
          requiresTunnel: updated?.customRequiresTunnel ?? existing.customRequiresTunnel ?? false,
          kind: 'custom' as const,
          enabled: updated?.enabled ?? existing.enabled,
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
        store.commit(AppSelection.events.customAppRemoved({ id: makeAppId(path.id) }))
        return { deleted: true }
      })
    )
    .handleRaw('LaunchApp', ({ path }) =>
      Effect.gen(function* () {
        const tunnel = yield* TunnelControl
        const store = yield* AppsStore

        const bundled = findBundled(path.id)
        const row = store.query(AppSelection.queries.byId$(path.id))

        const launchContext = ((): {
          url: (origin: string, launch: string) => string
          requiresTunnel: boolean
          isAction: boolean
        } | null => {
          if (bundled !== undefined) {
            return {
              url: bundled.url,
              requiresTunnel: bundled.requiresTunnel,
              isAction: bundled.kind === 'action',
            }
          }
          if (row !== undefined && row.kind === 'custom' && row.customUrl !== null) {
            const customUrl = row.customUrl
            return {
              url: (origin: string, launch: string) =>
                customUrl.replaceAll('{origin}', origin).replaceAll('{launch}', launch),
              requiresTunnel: row.customRequiresTunnel ?? false,
              isAction: false,
            }
          }
          return null
        })()

        if (launchContext === null) {
          return HttpServerResponse.unsafeJson(
            { error: 'AppNotFound', id: path.id },
            { status: 404 }
          )
        }

        const beforeState = yield* tunnel.getState

        const afterState = yield* (() => {
          if (!launchContext.requiresTunnel || beforeState.tunnelActive) {
            return Effect.succeed(beforeState)
          }
          return Effect.either(tunnel.setTunnelActive(true)).pipe(
            Effect.flatMap((result) => {
              if (result._tag === 'Right') {
                return Effect.succeed(result.right)
              }
              return Effect.logWarning(
                `[apps-core] tunnel activation failed: ${result.left._tag}: ${result.left.reason}`
              ).pipe(Effect.as(beforeState))
            })
          )
        })()

        if (path.id === FHIR_SHARING_ID || launchContext.isAction) {
          return HttpServerResponse.redirect(afterState.origin, { status: 302 })
        }

        const launch = nanoid()
        const target = launchContext.url(afterState.origin, launch)
        return HttpServerResponse.redirect(target, { status: 302 })
      })
    )
)

export { layer }
