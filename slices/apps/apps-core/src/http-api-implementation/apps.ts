import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { nanoid, type Store } from '@livestore/livestore'
import { Duration, Effect } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import {
  type schema as tunnelSchema,
  TunnelConfig,
  TunnelState,
  TunnelStore,
} from 'tunnel-core/livestore'

import { AppsApi } from '../http-api-definition/index.ts'
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

const TUNNEL_WAIT_TIMEOUT: Duration.Duration = Duration.seconds(15)

/**
 * Suspend until `currentEnabled` becomes true (the daemon has brought
 * the tunnel up), or the timeout elapses. On success returns the
 * composed public origin; on timeout returns `null` so the caller can
 * fall back to the local origin.
 */
const awaitCurrentEnabled = (
  tunnelStore: Store<typeof tunnelSchema, object>
): Effect.Effect<string | null, never, never> =>
  Effect.async<string | null, never>((resume) => {
    let disposed = false
    let dispose: (() => void) | null = null
    const handle = (state: {
      readonly currentEnabled: boolean
      readonly currentSubdomain: string | null
      readonly currentRootDomain: string | null
    }): void => {
      if (disposed) return
      if (
        state.currentEnabled &&
        state.currentSubdomain !== null &&
        state.currentRootDomain !== null
      ) {
        disposed = true
        dispose?.()
        resume(Effect.succeed(`https://${state.currentSubdomain}.${state.currentRootDomain}`))
      }
    }
    dispose = tunnelStore.subscribe(TunnelState.queries.current$, handle)
    return Effect.sync(() => {
      if (!disposed) {
        disposed = true
        dispose?.()
      }
    })
  }).pipe(
    Effect.timeoutOption(TUNNEL_WAIT_TIMEOUT),
    Effect.map((opt) => (opt._tag === 'Some' ? opt.value : null))
  )

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
        const tunnelStore = yield* TunnelStore
        const serverStore = yield* LocalHttpServerStore
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

        // Tunnel coordination: if the app requires a public origin and
        // the daemon hasn't brought the tunnel up yet, commit
        // `requestedEnabled: true` and await `currentEnabled` (with
        // timeout). On timeout, fall through to the local origin —
        // some launches still work without a tunnel.
        //
        // Skip the wait entirely if TunnelConfig hasn't been seeded
        // (no row, or `subdomain` is null) — no daemon present, no
        // point waiting. This is the node-host case where the slice's
        // tables exist but nothing seeds config or runs a daemon.
        let tunnelOrigin: string | null = null
        if (launchContext.requiresTunnel) {
          const config = tunnelStore.query(TunnelConfig.queries.current$)
          const current = tunnelStore.query(TunnelState.queries.current$)
          if (
            current.currentEnabled &&
            current.currentSubdomain !== null &&
            current.currentRootDomain !== null
          ) {
            tunnelOrigin = `https://${current.currentSubdomain}.${current.currentRootDomain}`
          } else if (config?.subdomain !== undefined && config.subdomain !== null) {
            yield* Effect.sync(() =>
              tunnelStore.commit(TunnelConfig.events.tunnelConfigSet({ requestedEnabled: true }))
            )
            tunnelOrigin = yield* awaitCurrentEnabled(tunnelStore)
            if (tunnelOrigin === null) {
              yield* Effect.logWarning(
                `[apps-core] LaunchApp ${path.id} timed out waiting for currentEnabled`
              )
            }
          }
        }

        // Re-check after tunnel state settles: the row may have been
        // deleted or kind-changed mid-flight. Bundled apps have static
        // shape so they don't need this round-trip.
        if (bundled === undefined) {
          const refreshed = store.query(AppSelection.queries.byId$(path.id))
          if (refreshed === undefined || refreshed.kind !== 'custom') {
            return HttpServerResponse.unsafeJson(
              { error: 'AppNotFound', id: path.id },
              { status: 404 }
            )
          }
        }

        const server = serverStore.query(ServerState.queries.current$)
        const publicOrigin = tunnelOrigin ?? server.localOrigin

        if (path.id === FHIR_SHARING_ID || launchContext.isAction) {
          return HttpServerResponse.redirect(publicOrigin, { status: 302 })
        }

        const launch = nanoid()
        const target = launchContext.url(publicOrigin, launch)
        if (!isLaunchableUrl(target, publicOrigin)) {
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
