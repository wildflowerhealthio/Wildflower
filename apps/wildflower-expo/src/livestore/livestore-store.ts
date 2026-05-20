import { makePersistedAdapter } from '@livestore/adapter-expo'
import type { Store } from '@livestore/livestore'
import { type ReactApi, useStore } from '@livestore/react'
import { Context } from 'effect'
import { ServerState } from 'local-http-server-core/livestore'
import { unstable_batchedUpdates as batchUpdates } from 'react-native'
import { getLivestoreOtelOptions } from 'telemetry-react-native'
import { TunnelConfig } from 'tunnel-core/livestore'
import { PORT, SERVICE_NAME, TUNNEL_ROOT_DOMAIN, TUNNEL_SUBDOMAIN } from '../constants.ts'
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
 *  - Commit `LocalHttpServerState.requestedRunning: true` so the LHS
 *    daemon starts serving as soon as the store is ready.
 *  - Seed `TunnelConfig` with canonical defaults *only when the row
 *    is absent* — a user who customized the subdomain via the settings
 *    UI keeps their override across restarts. `requestedRunning`
 *    defaults to `false` (tunnel is opt-in).
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
            subdomain: TUNNEL_SUBDOMAIN,
            rootDomain: TUNNEL_ROOT_DOMAIN,
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
