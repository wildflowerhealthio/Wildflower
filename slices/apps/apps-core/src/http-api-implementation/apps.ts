import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { Effect, Either } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { servedOrigin$, TunnelConfig, TunnelStore } from 'tunnel-core/livestore'

import { AppsApi } from '../http-api-definition/index.ts'
import { awaitTunnelRunning } from '../internal/await-tunnel-running.ts'
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

        // Non-tunnel apps always redirect to the loopback origin — even
        // if the tunnel is up, device-served bundles (`api-view`,
        // `patient-browser`, …) shouldn't round-trip through the relay.
        const { localHostname, port } = localStore.query(ServerState.queries.current$)
        const localOrigin = `http://${localHostname}:${port}`
        let tunnelFellBack = false
        let origin = localOrigin
        if (launchContext.requiresTunnel) {
          // `servedOrigin$` is `https://sub.root` when the tunnel is up
          // AND the relay has granted a bound origin, else the loopback
          // URL. The `https://` prefix is the unified "tunnel is usable"
          // signal — `tunnel-expo`'s `parseGrantedDomain` is what tags an
          // unbound rootDomain as the empty string, and `servedOrigin$`
          // folds that case back into loopback.
          const live = tunnelStore.query(servedOrigin$)
          if (live.startsWith('https://')) {
            origin = live // fast path: tunnel up & bound
          } else {
            // Cold path: commit intent, wait for the daemon to flip
            // running, then re-read `servedOrigin$`. `awaitTunnelRunning`
            // resolving with running=true but `servedOrigin$` still
            // loopback (relay refused / single-label hostname) folds into
            // the same fallback as the timeout. The `requestedRunning`
            // commit is sticky — see `awaitTunnelRunning` — interrupt does
            // not roll it back.
            const resolved = yield* Effect.gen(function* () {
              tunnelStore.commit(TunnelConfig.events.tunnelConfigSet({ requestedRunning: true }))
              yield* awaitTunnelRunning()
              return tunnelStore.query(servedOrigin$)
            }).pipe(
              Effect.tapError(() =>
                Effect.logWarning(
                  `[apps-core] tunnel did not start within deadline for ${path.id}; falling back to local origin`
                )
              ),
              Effect.either
            )
            if (Either.isLeft(resolved) || !resolved.right.startsWith('https://')) {
              tunnelFellBack = true
            } else {
              origin = resolved.right
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
          const target = tunnelFellBack ? appendTunnelUnavailable(origin) : origin
          return HttpServerResponse.redirect(target, { status: 302 })
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
        const target = tunnelFellBack ? appendTunnelUnavailable(resolved) : resolved
        return HttpServerResponse.redirect(target, { status: 302 })
      })
    )
)

export { layer }
