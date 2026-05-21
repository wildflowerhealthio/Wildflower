import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { Effect } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { TunnelConfig, TunnelState, TunnelStore } from 'tunnel-core/livestore'

import { AppsApi } from '../http-api-definition/index.ts'
import { awaitTunnelRunning, type RunningTunnel } from '../internal/await-tunnel-running.ts'
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
 * Public tunnel origin from `currentSubdomain` + `currentRootDomain`,
 * or `null` if either is unbound. `rootDomain` is the empty string
 * when the relay returns a single-label hostname (see
 * `tunnel-expo/src/startTunnel.ts`'s `parseGrantedDomain`), so empty
 * counts as unbound here too.
 */
const tunnelOrigin = (state: RunningTunnel): string | null => {
  const { currentSubdomain: sub, currentRootDomain: root } = state
  if (sub === null || sub === '' || root === null || root === '') return null
  return `https://${sub}.${root}`
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

        const localHostname = localStore.query(ServerState.queries.current$).localHostname
        const beforeTunnel = tunnelStore.query(TunnelState.queries.current$)

        // Pick the origin: local if no tunnel needed or already running
        // with a bound public name; otherwise commit `requestedRunning`
        // and wait for the daemon to flip `TunnelState.running`. Timeout
        // and unbound-state both fall back to the local origin (and
        // surface `?tunnel=unavailable` on the redirect). The
        // `requestedRunning` commit is sticky: see `awaitTunnelRunning`
        // — interrupt does not roll it back.
        let hostname = localHostname
        let tunnelFellBack = false
        if (launchContext.requiresTunnel) {
          if (beforeTunnel.running) {
            const live = tunnelOrigin(beforeTunnel)
            if (live === null) tunnelFellBack = true
            else hostname = live
          } else {
            tunnelStore.commit(TunnelConfig.events.tunnelConfigSet({ requestedRunning: true }))
            const outcome = yield* awaitTunnelRunning()
            if (outcome.kind === 'timed-out') {
              yield* Effect.logWarning(
                `[apps-core] tunnel did not start within deadline for ${path.id}; falling back to local origin`
              )
              tunnelFellBack = true
            } else {
              const live = tunnelOrigin(outcome.state)
              if (live === null) tunnelFellBack = true
              else hostname = live
            }
          }
        }

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
          const target = tunnelFellBack ? appendTunnelUnavailable(hostname) : hostname
          return HttpServerResponse.redirect(target, { status: 302 })
        }

        const launch = nanoid()
        const resolved = launchContext.url(hostname, launch)
        if (!isLaunchableUrl(resolved, hostname)) {
          yield* Effect.logWarning(
            `[apps-core] LaunchApp rejected resolved URL for ${path.id}: ${resolved}`
          )
          return HttpServerResponse.unsafeJson(
            { error: 'AppNotFound', id: path.id },
            { status: 404 }
          )
        }
        const target = tunnelFellBack ? appendTunnelUnavailable(resolved) : resolved
        return HttpServerResponse.redirect(target, { status: 302 })
      })
    )
)

export { layer }
