import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { Effect } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { servedOrigin$, TunnelConfig, TunnelStore, type ServedOrigin } from 'tunnel-core/livestore'

import { AppsApi } from '../http-api-definition/index.ts'
import { awaitTunnelRunning } from '../internal/await-tunnel-running.ts'
import { AppSelection, AppsStore } from '../livestore/index.ts'
import type { AppKind } from '../registry/app-item.ts'
import { BUNDLED_APPS, FHIR_SHARING_ID, findBundled } from '../registry/index.ts'

/**
 * Drive the tunnel toward `running` if it isn't already there, then return
 * whatever {@link servedOrigin$} reports. Fast path: tunnel is already up,
 * return immediately. Cold path: commit `requestedRunning` (sticky — see
 * {@link awaitTunnelRunning}), wait for the daemon, re-read. Timeout or
 * still-unavailable resolution both surface as `tunnelUnavailable` via
 * the LiveQuery's own taxonomy.
 */
const resolveLaunchOrigin = (appId: string): Effect.Effect<ServedOrigin, never, TunnelStore> =>
  Effect.gen(function* () {
    const tunnelStore = yield* TunnelStore
    const live = tunnelStore.query(servedOrigin$)
    if (live.kind === 'tunnel') return live
    tunnelStore.commit(TunnelConfig.events.tunnelConfigSet({ requestedRunning: true }))
    return yield* awaitTunnelRunning().pipe(
      Effect.map(() => tunnelStore.query(servedOrigin$)),
      Effect.catchTag('TunnelLaunchTimedOut', () =>
        Effect.zipRight(
          Effect.logWarning(
            `[apps-core] tunnel did not start within deadline for ${appId}; falling back to local origin`
          ),
          Effect.sync(() => tunnelStore.query(servedOrigin$))
        )
      )
    )
  })

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
    return parsed.protocol === 'https:' || parsed.hostname == '127.0.0.1'
  } catch {
    return false
  }
}

/**
 * Append `?tunnel=unavailable` so the SPA loading the redirect can
 * detect that the launch wanted a tunnel but had to settle for the
 * local origin. The SPA may surface this as a non-blocking banner.
 *
 * @remarks
 * Uses string manipulation rather than `new URL`: bundled launch URLs
 * (e.g. growth-chart, medication-viewer) carry raw colons / slashes in
 * their `iss=` query values that round-tripping through `URL` would
 * percent-encode — downstream consumers expect the un-encoded form.
 */
const appendTunnelUnavailable = (target: string): string => {
  const param = 'tunnel=unavailable'
  const hashIdx = target.indexOf('#')
  const base = hashIdx === -1 ? target : target.slice(0, hashIdx)
  const hash = hashIdx === -1 ? '' : target.slice(hashIdx)
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}${param}${hash}`
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

        // Non-tunnel apps always redirect to the loopback origin — device-served
        // bundles shouldn't round-trip through the relay even when the tunnel is up.
        const { localHostname, port } = localStore.query(ServerState.queries.current$)
        const localOrigin = `http://${localHostname}:${port}`
        const resolvedOrigin: ServedOrigin = launchContext.requiresTunnel
          ? yield* resolveLaunchOrigin(path.id)
          : { kind: 'loopback', origin: localOrigin }
        const { origin } = resolvedOrigin
        const finalize = (target: string): string =>
          resolvedOrigin.kind === 'tunnelUnavailable' ? appendTunnelUnavailable(target) : target

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
          return HttpServerResponse.redirect(finalize(origin), { status: 302 })
        }

        const launch = nanoid()
        const resolved = launchContext.url(origin, launch)
        if (!isLaunchableUrl(resolved, origin)) {
          yield* Effect.logWarning(
            `[apps-core] LaunchApp rejected resolved URL for ${path.id}: ${resolved}`
          )
          return HttpServerResponse.unsafeJson(
            { error: 'AppNotFound', id: path.id },
            { status: 404 }
          )
        }
        return HttpServerResponse.redirect(finalize(resolved), { status: 302 })
      })
    )
)

export { layer }
