import { makePersistedAdapter } from '@livestore/adapter-expo'
import type { Store } from '@livestore/livestore'
import { type ReactApi, useStore } from '@livestore/react'
import { Context } from 'effect'
import { ServerState } from 'local-http-server-core/livestore'
import { unstable_batchedUpdates as batchUpdates } from 'react-native'
import { getLivestoreOtelOptions } from 'telemetry-react-native'
import { TunnelConfig } from 'tunnel-core/livestore'
import {
  DEFAULT_TUNNEL_ROOT_DOMAIN,
  DEFAULT_TUNNEL_SUBDOMAIN,
  PORT,
  SERVICE_NAME,
} from '../constants.ts'
import { events as schemaEvents, schema } from './schema.ts'

const adapter = makePersistedAdapter({
  storage: {
    subDirectory: 'wildflower-db',
  },
})

/**
 * Subscribe to the singleton wildflower LiveStore. Suspends until the
 * store is loaded; once loaded, subsequent calls return synchronously
 * via the `StoreRegistry` cache. `otelOptions` is evaluated lazily so a
 * real tracer is wired in only after telemetry init has fired.
 *
 * The `boot` callback fires once per store creation; we use it to:
 *
 *  - **Force** `LocalHttpServerState.requestedRunning: true` on every
 *    boot, overwriting any prior user state. The app is non-functional
 *    without the LHS daemon (the WebView has nothing to load), so we
 *    treat it as a required runtime invariant rather than a preference.
 *  - Seed `TunnelConfig` with canonical defaults *only when the row
 *    is absent* — a user who customized the subdomain via the settings
 *    UI keeps their override across restarts. `requestedRunning`
 *    defaults to `false` (tunnel is opt-in, so user-chosen state is
 *    preserved across boots — the opposite policy from LHS).
 */
const useWildflowerStore = (): Store<typeof schema, object> & ReactApi =>
  useStore({
    storeId: 'wildflower-store',
    schema,
    adapter,
    batchUpdates,
    otelOptions: getLivestoreOtelOptions(SERVICE_NAME),
    boot: (store) => {
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
            localPort: PORT,
          })
        )
      }
    },
  })

class WildflowerStore extends Context.Tag('WildflowerStore')<
  WildflowerStore,
  Store<typeof schema, object>
>() {}

export { useWildflowerStore, WildflowerStore }
