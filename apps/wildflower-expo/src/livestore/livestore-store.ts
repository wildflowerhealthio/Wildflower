import { makePersistedAdapter } from '@livestore/adapter-expo'
import type { Store } from '@livestore/livestore'
import { type ReactApi, StoreRegistry, useStore } from '@livestore/react'
import { Context } from 'effect'
import { ServerState } from 'local-http-server-core/livestore'
import { unstable_batchedUpdates as batchUpdates } from 'react-native'
import { getLivestoreOtelOptions } from 'telemetry-react-native'
import { TunnelConfig } from 'tunnel-core/livestore'
import { DEFAULT_TUNNEL_ROOT_DOMAIN, DEFAULT_TUNNEL_SUBDOMAIN, SERVICE_NAME } from '../constants.ts'
import { events as schemaEvents, schema } from './schema.ts'

const adapter = makePersistedAdapter({
  storage: {
    subDirectory: 'wildflower-db',
  },
})

/**
 * The single set of options that drive both the module-scope `retain`
 * (which kicks off the SQLite open + migrate + boot at module-eval) and
 * the in-component `useStore` call below — `useStore` looks up the
 * same `storeId` in the registry and either returns the cached handle
 * synchronously or suspends on the in-flight load.
 *
 * `otelOptions` is evaluated at module-eval time, so
 * `setup-instrumentation.ts` must run before this file in `index.ts` —
 * otherwise the snapshot captured here is a no-op tracer and Livestore
 * spans never reach Sentry.
 *
 * The `boot` callback fires once per store creation; we use it to:
 *
 *  - Seed `LocalHttpServerState.requestedRunning: true` *only when it
 *    is currently false* — the app is non-functional without the LHS
 *    daemon (the WebView has nothing to load), so the on-boot nudge
 *    flips a user who previously paused it back to running. A user
 *    already in the running state is left alone.
 *  - Seed `TunnelConfig` with canonical defaults *only when the row
 *    is absent* — a user who customized the subdomain via the settings
 *    UI keeps their override across restarts. `requestedRunning`
 *    defaults to `false` (tunnel is opt-in, so user-chosen state is
 *    preserved across boots — the opposite policy from LHS).
 */
const wildflowerStoreOptions = {
  storeId: 'wildflower-store',
  schema,
  adapter,
  batchUpdates,
  otelOptions: getLivestoreOtelOptions(SERVICE_NAME),
  boot: (store: Store<typeof schema, object>): void => {
    const server = store.query(ServerState.queries.current$)
    if (!server.requestedRunning) {
      store.commit(schemaEvents.localHttpServerStateSet({ requestedRunning: true }))
    }
    const tunnel = store.query(TunnelConfig.queries.current$)
    if (tunnel === undefined) {
      store.commit(
        schemaEvents.tunnelConfigSet({
          subdomain: DEFAULT_TUNNEL_SUBDOMAIN,
          rootDomain: DEFAULT_TUNNEL_ROOT_DOMAIN,
        })
      )
    }
  },
} as const

/**
 * Module-scope registry. Owned by this module rather than constructed
 * inside `AppRuntimeProvider`'s `useState` so the load can be kicked
 * off at module-eval time (before React mounts), overlapping the
 * `makeAdapter` cost with bundle eval / RN bridge warmup / splash
 * display rather than spending it inside the Suspense window.
 *
 * `AppRuntimeProvider` wires this same instance into
 * `<StoreRegistryProvider>` so `useWildflowerStore` (which calls
 * `useStore(wildflowerStoreOptions)`) resolves against the same cache.
 */
const wildflowerStoreRegistry = new StoreRegistry()

// Trigger the load now and hold it in the cache for the app's
// lifetime. `retain` does both: it kicks off `makeAdapter` /
// schema migrate / boot, and holds the entry so it isn't garbage
// collected during the eval → first-`useStore` gap (which `preload`
// would allow per its TSDoc). The release function is captured so
// `__resetForTests` can drop the retention; in app code it is
// effectively retain-forever, matching the singleton's real lifetime.
let releaseRetention: (() => void) | null = wildflowerStoreRegistry.retain(wildflowerStoreOptions)

/**
 * Subscribe to the singleton wildflower LiveStore. Suspends until the
 * store is loaded; once loaded, subsequent calls return synchronously
 * via the `StoreRegistry` cache. The cache is warmed eagerly at
 * module-eval (see {@link wildflowerStoreRegistry}), so by the time
 * React reaches this hook the load is typically already complete.
 */
const useWildflowerStore = (): Store<typeof schema, object> & ReactApi =>
  useStore(wildflowerStoreOptions)

class WildflowerStore extends Context.Tag('wildflower-expo/WildflowerStore')<
  WildflowerStore,
  Store<typeof schema, object>
>() {}

/**
 * Release the module-scope `retain()` so the registry can dispose
 * the cached store, then null the local release handle so a second
 * call is a no-op. For test setup hooks (e.g. `beforeAll`/`afterAll`)
 * that need to import this module without keeping the real adapter
 * alive — the app does not call this in normal operation (the
 * wildflower store is a singleton held for the app's lifetime).
 *
 * @internal
 */
const __resetForTests = (): void => {
  if (releaseRetention !== null) {
    releaseRetention()
    releaseRetention = null
  }
}

export { useWildflowerStore, wildflowerStoreRegistry, WildflowerStore, __resetForTests }
