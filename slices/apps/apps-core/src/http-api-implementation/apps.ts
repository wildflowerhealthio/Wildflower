import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { Effect } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { TunnelConfig, TunnelState, TunnelStore } from 'tunnel-core/livestore'

import { AppsApi } from '../http-api-definition/index.ts'
import {
  awaitCurrentRunning,
  type RunningTunnel,
  type TunnelLaunchOutcome,
} from '../internal/await-current-running.ts'
import { AppSelection, AppsStore } from '../livestore/index.ts'
import type { AppKind } from '../registry/app-item.ts'
import { BUNDLED_APPS, FHIR_SHARING_ID, findBundled } from '../registry/index.ts'

interface AppEntry {
  id: string
  name: string
  subtitle?: string
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
    .map((row) => {
      const subtitleValue = row.customUrl ?? ''
      const entry: AppEntry = {
        id: row.id,
        name: row.customName ?? 'Custom App',
        requiresTunnel: row.customRequiresTunnel ?? false,
        kind: 'custom',
        enabled: row.enabled,
      }
      if (subtitleValue !== '') entry.subtitle = subtitleValue
      return entry
    })

  return [...bundled, ...custom]
}

/**
 * Compose the public tunnel origin from the daemon-owned
 * `currentSubdomain` + `currentRootDomain`. The daemon won't surface
 * those fields until it's bound, so the call site only invokes this
 * once `awaitCurrentRunning` has returned `kind: 'running'`. Returns
 * `null` if either field is missing — should be treated as "fall back
 * to local origin" by the caller.
 */
const tunnelOrigin = (state: RunningTunnel): string | null => {
  if (state.currentSubdomain === null || state.currentRootDomain === null) return null
  return `https://${state.currentSubdomain}.${state.currentRootDomain}`
}

/**
 * Defense-in-depth at launch time. `CustomAppUrlSchema` rejects bad
 * shapes on write, but `LaunchApp` re-validates the *resolved* URL —
 * after `{origin}` interpolation — so a custom app whose template
 * produced a weird URL can't 302 to it. Acceptable targets: any URL
 * sharing the live origin (`originPrefix`) or any absolute `https://`
 * URL. Anything else is treated as "not found" to avoid leaking a
 * distinct rejection signal.
 */
const isLaunchableUrl = (target: string, originPrefix: string): boolean => {
  if (target.startsWith(originPrefix)) return true
  try {
    const parsed = new URL(target)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
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
    .handleRaw('LaunchApp', ({ path }) =>
      Effect.gen(function* () {
        const appsStore = yield* AppsStore
        const tunnelStore = yield* TunnelStore
        const localStore = yield* LocalHttpServerStore

        const bundled = findBundled(path.id)
        const row = appsStore.query(AppSelection.queries.byId$(path.id))

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

        const localOrigin = localStore.query(ServerState.queries.current$).localOrigin
        const beforeTunnel = tunnelStore.query(TunnelState.queries.current$)

        // Compute the origin we'll redirect through. If the app doesn't
        // require a tunnel, pin to the local origin so launches keep
        // working even when the relay is offline. If it does require
        // one and the tunnel isn't already running, commit
        // `requestedRunning: true` and suspend on `awaitCurrentRunning`
        // — the daemon flips `TunnelState.running` once bound, or the
        // 15s timeout fires and we fall back.
        const origin = yield* (() => {
          if (!launchContext.requiresTunnel) return Effect.succeed(localOrigin)
          if (beforeTunnel.running) {
            const live = tunnelOrigin(beforeTunnel)
            return Effect.succeed(live ?? localOrigin)
          }
          return Effect.gen(function* () {
            yield* Effect.sync(() =>
              tunnelStore.commit(TunnelConfig.events.tunnelConfigSet({ requestedRunning: true }))
            )
            const outcome: TunnelLaunchOutcome = yield* awaitCurrentRunning()
            if (outcome.kind === 'timed-out') {
              yield* Effect.logWarning(
                `[apps-core] tunnel did not start within deadline for ${path.id}; falling back to local origin`
              )
              return localOrigin
            }
            return tunnelOrigin(outcome.state) ?? localOrigin
          })
        })()

        // Re-check after tunnel state settles: the row may have been
        // deleted or kind-changed mid-flight. Bundled apps have static
        // shape so they don't need this round-trip.
        if (bundled === undefined) {
          const refreshed = appsStore.query(AppSelection.queries.byId$(path.id))
          if (refreshed === undefined || refreshed.kind !== 'custom') {
            return HttpServerResponse.unsafeJson(
              { error: 'AppNotFound', id: path.id },
              { status: 404 }
            )
          }
        }

        if (path.id === FHIR_SHARING_ID || launchContext.isAction) {
          return HttpServerResponse.redirect(origin, { status: 302 })
        }

        const launch = nanoid()
        const target = launchContext.url(origin, launch)
        if (!isLaunchableUrl(target, origin)) {
          yield* Effect.logWarning(
            `[apps-core] LaunchApp rejected resolved URL for ${path.id}: ${target}`
          )
          return HttpServerResponse.unsafeJson(
            { error: 'AppNotFound', id: path.id },
            { status: 404 }
          )
        }
        return HttpServerResponse.redirect(target, { status: 302 })
      })
    )
)

export { layer }
